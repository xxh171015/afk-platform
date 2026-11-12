import {
  formatDisplayId,
  isSandboxOomError,
  type LocateReason,
  parseDisplayId,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { recordAction } from "../events/human-actions.ts";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";
import { contextFor } from "../links/context.ts";
import { inTransaction, lockSpec } from "../scheduling/scheduler.ts";
import {
  type ResultFacts,
  type StageJob,
  writeFacts,
} from "../stages/results.ts";
import { createSpec } from "./planning.ts";

// Locate: a read-only agent run that maps a bug report onto a repo, files, and the
// original Spec. It is not a ticket Stage and does not make a Ticket
// (GLOSSARY Locate).

export const LOCATE_STAGE = "locate-bug";

export interface LocatePayload {
  specId: number;
  projectId: number;
  repoId: number;
}

export function readLocatePayload(
  payload: Record<string, unknown>,
): LocatePayload | undefined {
  const { specId, projectId, repoId, stage, ticketId } = payload;
  if (stage !== LOCATE_STAGE || ticketId !== undefined) return undefined;
  if (
    typeof specId !== "number" ||
    typeof projectId !== "number" ||
    typeof repoId !== "number"
  )
    return undefined;
  return { specId, projectId, repoId };
}

const locateKeyPrefix = (specId: number) =>
  `${formatDisplayId("spec", specId)}:${LOCATE_STAGE}:`;

async function nextLocateKey(
  client: Queryable,
  specId: number,
): Promise<string> {
  const prefix = locateKeyPrefix(specId);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return `${prefix}${Number(earlier.rows[0]?.n) + 1}`;
}

export async function enqueueLocateJob(
  client: Queryable,
  payload: LocatePayload,
): Promise<void> {
  await enqueueJob(client, {
    type: "agent-run",
    payload: {
      stage: LOCATE_STAGE,
      specId: payload.specId,
      projectId: payload.projectId,
      repoId: payload.repoId,
    },
    idempotencyKey: await nextLocateKey(client, payload.specId),
  });
}

function titleFromReport(body: string): string {
  const line = body
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  if (!line) return "Bug report";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "bug-report";
}

async function workspaceRepo(
  pool: Queryable,
  projectId: number,
  planningRepo?: string,
): Promise<{ id: number } | undefined> {
  if (planningRepo !== undefined) {
    const named = await pool.query<{ id: number }>(
      "SELECT id FROM repos WHERE project_id = $1 AND name = $2",
      [projectId, planningRepo],
    );
    if (named.rows[0]) return named.rows[0];
  }
  const first = await pool.query<{ id: number }>(
    "SELECT id FROM repos WHERE project_id = $1 ORDER BY id LIMIT 1",
    [projectId],
  );
  return first.rows[0];
}

export type SubmitBugResult =
  | { status: "ok"; spec: { id: number; displayId: string } }
  | { status: "no-project" }
  | { status: "no-repo"; message: string }
  | { status: "invalid"; message: string };

export async function submitBug(
  pool: pg.Pool,
  input: {
    projectId: number;
    body: string;
    title?: string;
    slug?: string;
    planningRepo?: string;
  },
): Promise<SubmitBugResult> {
  const title = input.title?.trim() || titleFromReport(input.body);
  const baseSlug = input.slug ?? slugFromTitle(title);
  const repo = await workspaceRepo(pool, input.projectId, input.planningRepo);
  if (!repo) {
    const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
      input.projectId,
    ]);
    if (project.rowCount === 0) return { status: "no-project" };
    return {
      status: "no-repo",
      message: "the project has no repo to locate in",
    };
  }

  for (let n = 1; n <= 50; n += 1) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const created = await createSpec(pool, {
      projectId: input.projectId,
      type: "bug",
      slug,
      title,
      body: input.body,
      planningRepo: input.planningRepo,
    });
    if (created.status === "no-project") return created;
    if (created.status === "no-repo") return created;
    if (created.status === "invalid-source") {
      return { status: "invalid", message: created.message };
    }
    if (created.status === "slug-taken") continue;
    await inTransaction(pool, async (client) => {
      await client.query(
        "UPDATE specs SET locate_state = 'pending', locate_reason = NULL WHERE id = $1",
        [created.spec.id],
      );
      await enqueueLocateJob(client, {
        specId: created.spec.id,
        projectId: input.projectId,
        repoId: repo.id,
      });
    });
    return created;
  }
  return { status: "invalid", message: "could not pick a unique slug" };
}

const LocateCommit = z.object({
  sha: z.string(),
  spec: z.string().optional(),
  ticket: z.string().optional(),
  run: z.string().optional(),
});

const LocateFacts = z.object({
  repo: z.string(),
  files: z.array(z.string()).max(200).default([]),
  evidence: z.string().default(""),
  reproduction: z.string().default(""),
  commits: z.array(LocateCommit).default([]),
});

export const LocateResultSchema = z.object({
  stage: z.literal(LOCATE_STAGE),
  outcome: z.enum(["found", "unlocated", "invalid-output", "timeout"]),
  locate: LocateFacts.optional(),
  run: z
    .object({
      agent: z.string().optional(),
      model: z.string().optional(),
      skillsSha: z.string().optional(),
      prompt: z.string().optional(),
      result: z.string().optional(),
      durationMs: z.number().int().min(0).optional(),
      output: z.unknown().optional(),
      startedAt: z.iso.datetime().optional(),
      finishedAt: z.iso.datetime().optional(),
    })
    .optional(),
});
export type LocateResult = z.infer<typeof LocateResultSchema>;

function pointerLines(
  files: {
    path: string;
    specs: { displayId: string }[];
    tickets: { displayId: string }[];
    pullRequests: { number: number; url: string }[];
    decisions: { specDisplayId: string; heading: string }[];
    outOfScope: { specDisplayId: string; heading: string }[];
    adrs: { path: string }[];
  }[],
): string[] {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(file.path);
    const specs = file.specs.map((spec) => spec.displayId);
    if (specs.length) lines.push(`  specs: ${specs.join(", ")}`);
    const tickets = file.tickets.map((ticket) => ticket.displayId);
    if (tickets.length) lines.push(`  tickets: ${tickets.join(", ")}`);
    for (const pull of file.pullRequests) {
      lines.push(`  pull request: ${pull.url}`);
    }
    for (const decision of file.decisions) {
      lines.push(`  decisions: ${decision.specDisplayId} ${decision.heading}`);
    }
    for (const scope of file.outOfScope) {
      lines.push(`  out of scope: ${scope.specDisplayId} ${scope.heading}`);
    }
    for (const adr of file.adrs) {
      lines.push(`  adr: ${adr.path}`);
    }
  }
  return lines;
}

function locateAppendix(
  facts: z.infer<typeof LocateFacts>,
  pointers: string[],
): string {
  const files =
    facts.files.length > 0
      ? facts.files.map((path) => `- ${path}`).join("\n")
      : "(none)";
  return [
    `repo: ${facts.repo}`,
    `files:`,
    files,
    `evidence: ${facts.evidence}`,
    `reproduction: ${facts.reproduction}`,
    ...(pointers.length > 0 ? ["", "### Pointers", ...pointers] : []),
  ].join("\n");
}

function withLocateAppendix(body: string, appendix: string): string {
  const stripped = body.replace(/\n## Locate\n[\s\S]*$/, "").trimEnd();
  return `${stripped}\n\n## Locate\n\n${appendix}\n`;
}

async function sourceSpecIdOf(
  client: Queryable,
  projectId: number,
  bugId: number,
  commits: z.infer<typeof LocateCommit>[],
): Promise<number | undefined> {
  for (const commit of commits) {
    if (!commit.spec) continue;
    const parsed = parseDisplayId(commit.spec);
    if (parsed?.kind !== "spec" || parsed.id === bugId) continue;
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM specs WHERE id = $1 AND project_id = $2",
      [parsed.id, projectId],
    );
    if (rows[0]) return rows[0].id;
  }
  return undefined;
}

export async function markLocateClaimed(
  pool: Queryable,
  job: StageJob,
): Promise<void> {
  const read = readLocatePayload(job.payload);
  if (!read) return;
  await pool.query(
    `INSERT INTO runs (spec_id, repo_id, job_id, stage, attempt, started_at)
     SELECT $1, $2, $3, $4,
       (SELECT count(*) FROM runs r WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = $4) + 1,
       now()
     FROM specs s WHERE s.id = $1
     ON CONFLICT (job_id) DO NOTHING`,
    [read.specId, read.repoId, job.id, LOCATE_STAGE],
  );
}

export async function recordLocateResult(
  client: pg.PoolClient,
  job: StageJob,
  result: unknown,
): Promise<{ status: "applied" | "ignored" | "not-locate" }> {
  const read = readLocatePayload(job.payload);
  if (!read) return { status: "not-locate" };
  await lockSpec(client, read.specId);
  const spec = await client.query<{
    id: number;
    project_id: number;
    body: string;
    state: string;
    type: string;
  }>("SELECT id, project_id, body, state, type FROM specs WHERE id = $1", [
    read.specId,
  ]);
  const row = spec.rows[0];
  if (row?.type !== "bug" || row.state !== "draft") {
    return { status: "ignored" };
  }
  const parsed = LocateResultSchema.safeParse(result);
  const valid = parsed.success ? parsed.data : undefined;
  await writeFacts(
    client,
    {
      spec_id: read.specId,
      repo_id: read.repoId,
      ticket_id: null,
      content_version: null,
    },
    job,
    LOCATE_STAGE,
    valid
      ? ({
          outcome: valid.outcome,
          run: valid.run,
          findings: [],
          extraRuns: [],
        } as ResultFacts)
      : undefined,
    result,
  );
  if (valid?.outcome !== "found" || !valid.locate) {
    const reason: LocateReason =
      valid?.outcome === "unlocated" ? "bug-unlocated" : "invalid-output";
    await failLocate(client, row.id, reason, job.id);
    return { status: "applied" };
  }
  const sourceSpecId = await sourceSpecIdOf(
    client,
    row.project_id,
    row.id,
    valid.locate.commits,
  );
  if (sourceSpecId === undefined) {
    await failLocate(client, row.id, "bug-unlocated", job.id);
    return { status: "applied" };
  }

  const files = valid.locate.files.map((path) => ({
    path,
    commits: valid.locate?.commits ?? [],
  }));
  const pointers = await contextFor(client, {
    repo: valid.locate.repo,
    files:
      files.length > 0
        ? files
        : [{ path: valid.locate.repo, commits: valid.locate.commits }],
  });
  const pointerText =
    pointers.status === "ok" ? pointerLines(pointers.files) : [];
  const appendix = locateAppendix(valid.locate, pointerText);
  await client.query(
    `UPDATE specs SET source_spec_id = $2, body = $3, locate_state = 'found', locate_reason = NULL
     WHERE id = $1 AND type = 'bug' AND state = 'draft'`,
    [row.id, sourceSpecId, withLocateAppendix(row.body, appendix)],
  );
  await recordLocateEvent(client, {
    specId: row.id,
    jobId: job.id,
    repoId: read.repoId,
    fromState: "pending",
    toState: "found",
    reason: null,
  });
  return { status: "applied" };
}

async function failLocate(
  client: Queryable,
  specId: number,
  reason: LocateReason,
  jobId: number,
): Promise<void> {
  await client.query(
    `UPDATE specs SET locate_state = 'failed', locate_reason = $2 WHERE id = $1 AND type = 'bug'`,
    [specId, reason],
  );
  await recordLocateEvent(client, {
    specId,
    jobId,
    repoId: null,
    fromState: "pending",
    toState: "failed",
    reason,
  });
}

async function recordLocateEvent(
  client: Queryable,
  input: {
    specId: number;
    jobId: number | null;
    repoId: number | null;
    fromState: string;
    toState: string;
    reason: string | null;
  },
): Promise<void> {
  await client.query(
    `SELECT afk_record_event('locate', $1, NULL, $2, $3, $4, $5, $6, NULL, '{}'::jsonb)`,
    [
      input.specId,
      input.jobId,
      input.repoId,
      input.fromState,
      input.toState,
      input.reason,
    ],
  );
}

export async function recordLocateJobFailure(
  client: pg.PoolClient,
  job: StageJob,
  error: string,
): Promise<{ status: "applied" | "not-locate" | "ignored" }> {
  const read = readLocatePayload(job.payload);
  if (!read) return { status: "not-locate" };
  await lockSpec(client, read.specId);
  const spec = await client.query<{ type: string; state: string }>(
    "SELECT type, state FROM specs WHERE id = $1",
    [read.specId],
  );
  const row = spec.rows[0];
  if (row?.type !== "bug" || row.state !== "draft") {
    return { status: "ignored" };
  }
  const reason: LocateReason = isSandboxOomError(error)
    ? "sandbox-oom"
    : "job-failed";
  await failLocate(client, read.specId, reason, job.id);
  return { status: "applied" };
}

export type RetryLocateResult =
  | { status: "ok" }
  | { status: "no-spec" }
  | { status: "not-failed"; message: string };

export async function retryLocate(
  pool: pg.Pool,
  specId: number,
): Promise<RetryLocateResult> {
  return inTransaction(pool, async (client) => {
    await lockSpec(client, specId);
    const spec = await client.query<{
      type: string;
      state: string;
      locate_state: string | null;
      project_id: number;
    }>(
      "SELECT type, state, locate_state, project_id FROM specs WHERE id = $1",
      [specId],
    );
    const row = spec.rows[0];
    if (!row) return { status: "no-spec" };
    if (row.type !== "bug" || row.locate_state !== "failed") {
      return {
        status: "not-failed",
        message: "locate is not waiting for a retry",
      };
    }
    const last = await client.query<{ repo_id: number | null }>(
      `SELECT (payload->>'repoId')::int AS repo_id FROM jobs
       WHERE type = 'agent-run' AND (payload->>'specId')::int = $1
         AND payload->>'stage' = $2
       ORDER BY id DESC LIMIT 1`,
      [specId, LOCATE_STAGE],
    );
    const repoId =
      last.rows[0]?.repo_id ??
      (await workspaceRepo(client, row.project_id))?.id;
    if (repoId === undefined) {
      return {
        status: "not-failed",
        message: "the project has no repo to locate in",
      };
    }
    await client.query(
      "UPDATE specs SET locate_state = 'pending', locate_reason = NULL WHERE id = $1",
      [specId],
    );
    await enqueueLocateJob(client, {
      specId,
      projectId: row.project_id,
      repoId,
    });
    await recordAction(client, "retry-locate", { specId });
    return { status: "ok" };
  });
}
