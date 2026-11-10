import {
  branchNames,
  formatDisplayId,
  MAX_PLANNING_PATCH_BYTES,
  PLANNING_COMMIT_JOB,
  type PlanningCommitResult,
} from "@afk/shared";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";
import { inTransaction, schedulePass } from "../scheduling/scheduler.ts";

// The planning commit (GLOSSARY「Planning commit」, ADR 0005): once a spec with a planning repo is confirmed, a
// worker commits the planning docs patch onto the planning repo's integration branch, or, without a patch, takes
// the default branch's head. No ticket of the spec starts before it is there.

const keyPrefix = (specId: number) =>
  `${formatDisplayId("spec", specId)}:${PLANNING_COMMIT_JOB}:`;

// Queues the job and marks the planning commit pending. It holds the planning repo's integration branch lock, the
// one ticket merges take, so it never races a merge onto that branch.
// `waived`: a person gave the patch up, so the commit is the default branch's head and the spec says so.
export async function enqueuePlanningCommit(
  client: pg.PoolClient,
  specId: number,
  { waived = false } = {},
): Promise<void> {
  const { rows } = await client.query<{ slug: string; repo_id: number }>(
    "SELECT slug, planning_repo_id AS repo_id FROM specs WHERE id = $1",
    [specId],
  );
  const spec = rows[0];
  if (!spec) throw new Error(`no spec ${specId}`);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${keyPrefix(specId)}%`],
  );
  await client.query(
    "UPDATE specs SET planning_state = 'pending', planning_conflict = NULL WHERE id = $1",
    [specId],
  );
  await enqueueJob(client, {
    type: PLANNING_COMMIT_JOB,
    payload: { specId, ...(waived ? { waived: true } : {}) },
    idempotencyKey: `${keyPrefix(specId)}${Number(earlier.rows[0]?.n) + 1}`,
    lockKey: `integration:${spec.repo_id}:spec/${spec.slug}`,
  });
}

export function readPlanningPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): { specId: number; waived: boolean } | undefined {
  const { specId, waived } = job.payload;
  return job.type === PLANNING_COMMIT_JOB && typeof specId === "number"
    ? { specId, waived: waived === true }
    : undefined;
}

export interface PlanningTask {
  spec: { id: number; displayId: string; title: string };
  repo: { name: string; url: string; defaultBranch: string };
  integrationBranch: string;
  // null: no planning docs to commit, the planning commit is the default branch's head
  patch: string | null;
  message: string;
}

export async function buildPlanningTask(
  pool: Queryable,
  specId: number,
): Promise<PlanningTask | undefined> {
  const { rows } = await pool.query<{
    title: string;
    slug: string;
    branch_namespace: string | null;
    planning_patch: string | null;
    name: string;
    url: string;
    default_branch: string;
  }>(
    `SELECT s.title, s.slug, s.branch_namespace, s.planning_patch, r.name, r.url, r.default_branch
     FROM specs s JOIN repos r ON r.id = s.planning_repo_id WHERE s.id = $1`,
    [specId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const displayId = formatDisplayId("spec", specId);
  return {
    spec: { id: specId, displayId, title: row.title },
    repo: { name: row.name, url: row.url, defaultBranch: row.default_branch },
    integrationBranch: branchNames(row.branch_namespace).integration(row.slug),
    patch: row.planning_patch,
    message: `Planning docs for ${displayId} ${row.title}\n\nSpec: ${displayId}`,
  };
}

const SHA = /^[0-9a-f]{40}$/;

function readResult(result: unknown): PlanningCommitResult | undefined {
  const r = result as Record<string, unknown> | null;
  if (r?.stage !== PLANNING_COMMIT_JOB) return undefined;
  if (
    (r.outcome === "committed" || r.outcome === "unchanged") &&
    typeof r.sha === "string" &&
    SHA.test(r.sha)
  ) {
    return { stage: PLANNING_COMMIT_JOB, outcome: r.outcome, sha: r.sha };
  }
  if (
    r.outcome === "conflict" &&
    Array.isArray(r.files) &&
    r.files.every((f) => typeof f === "string")
  ) {
    return {
      stage: PLANNING_COMMIT_JOB,
      outcome: "conflict",
      files: r.files as string[],
    };
  }
  return undefined;
}

// The worker's answer. The patch goes once the planning commit exists (only its SHA is kept); a conflict keeps it
// and blocks the spec's start until a person retries or waives. Called inside the completing transaction.
export async function recordPlanningResult(
  client: pg.PoolClient,
  payload: { specId: number; waived: boolean },
  result: unknown,
): Promise<void> {
  const answer = readResult(result);
  if (!answer) throw new Error("not a planning-commit result");
  const { specId } = payload;
  await client.query("SELECT 1 FROM specs WHERE id = $1 FOR UPDATE", [specId]);
  if (answer.outcome === "conflict") {
    await client.query(
      "UPDATE specs SET planning_state = 'blocked', planning_conflict = $2 WHERE id = $1 AND planning_state = 'pending'",
      [specId, JSON.stringify(answer.files)],
    );
    return;
  }
  await client.query(
    `UPDATE specs SET planning_sha = $2, planning_patch = NULL, planning_conflict = NULL, planning_state = $3,
       planning_docs_committed = $4
     WHERE id = $1 AND planning_state = 'pending'`,
    [
      specId,
      answer.sha,
      payload.waived ? "waived" : "done",
      answer.outcome === "committed",
    ],
  );
  await schedulePass(client, specId);
}

export type PlanningActionResult =
  | { status: "ok" }
  | { status: "no-spec" }
  | { status: "not-blocked"; message: string }
  | { status: "invalid"; message: string };

// A person acts on planning docs that did not apply: send them again (after merging the default branch in by hand),
// or give them up. Either way the planning commit is made again before any ticket starts.
export async function actOnBlockedPlanning(
  pool: pg.Pool,
  specId: number,
  action: { kind: "retry"; patch: string } | { kind: "waive" },
): Promise<PlanningActionResult> {
  if (
    action.kind === "retry" &&
    Buffer.byteLength(action.patch) > MAX_PLANNING_PATCH_BYTES
  ) {
    return {
      status: "invalid",
      message: `the planning docs patch is over ${MAX_PLANNING_PATCH_BYTES} bytes`,
    };
  }
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ planning_state: string | null }>(
      "SELECT planning_state FROM specs WHERE id = $1 FOR UPDATE",
      [specId],
    );
    if (!rows[0]) return { status: "no-spec" };
    if (rows[0].planning_state !== "blocked") {
      return {
        status: "not-blocked",
        message: `${formatDisplayId("spec", specId)}'s planning docs are not blocked`,
      };
    }
    await client.query("UPDATE specs SET planning_patch = $2 WHERE id = $1", [
      specId,
      action.kind === "retry" && action.patch ? action.patch : null,
    ]);
    await enqueuePlanningCommit(client, specId, {
      waived: action.kind === "waive",
    });
    await recordAction(
      client,
      action.kind === "retry" ? "retry-planning" : "waive-planning",
      { specId },
    );
    return { status: "ok" };
  });
}

// The worker could not make the planning commit (it could not fetch or push, say): tried again, three times in a
// row in all, then the spec waits for a person like a conflict does, with no files named.
export async function planningCommitFailed(
  client: pg.PoolClient,
  read: { specId: number; waived: boolean },
  maxFailures: number,
): Promise<"requeued" | "blocked" | "ignored"> {
  const { rows } = await client.query<{ planning_state: string | null }>(
    "SELECT planning_state FROM specs WHERE id = $1 FOR UPDATE",
    [read.specId],
  );
  if (rows[0]?.planning_state !== "pending") return "ignored";
  const jobs = await client.query<{ state: string }>(
    "SELECT state FROM jobs WHERE idempotency_key LIKE $1 ORDER BY id DESC",
    [`${keyPrefix(read.specId)}%`],
  );
  const inARow = jobs.rows.findIndex((j) => j.state !== "failed");
  const failures = inARow === -1 ? jobs.rows.length : inARow;
  if (failures < maxFailures) {
    await enqueuePlanningCommit(client, read.specId, { waived: read.waived });
    return "requeued";
  }
  await client.query(
    "UPDATE specs SET planning_state = 'blocked', planning_conflict = '[]' WHERE id = $1",
    [read.specId],
  );
  return "blocked";
}
