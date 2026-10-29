import {
  type BlockedReason,
  formatDisplayId,
  type SpecState,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { lockSpec } from "../scheduling/scheduler.ts";
import {
  enqueueHostSync,
  enqueueOpenPr,
  type HostSyncPayload,
  type OpenPrPayload,
  SYNC_INTERVAL_SECONDS,
} from "./host-jobs.ts";

// A spec's pull requests: opened once its repos are all finalized, then followed until a person has merged them
// all. The platform only records what the host says; it has no call that merges (docs/design.md「代码托管」).

export type HostTask =
  | {
      kind: "open-pr";
      repoUrl: string;
      base: string;
      head: string;
      title: string;
      body: string;
      draft: boolean;
    }
  | {
      kind: "host-sync";
      pulls: { id: number; repoUrl: string; number: number }[];
    };

const PullFacts = {
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  headSha: z.string().min(1),
  ci: z.enum(["none", "pending", "success", "failure"]),
  review: z.enum(["none", "approved", "changes-requested"]),
};

export const OpenPrResultSchema = z.object({
  stage: z.literal("open-pr"),
  outcome: z.literal("opened"),
  number: z.number().int().min(1),
  url: z.string().min(1),
  ...PullFacts,
});

export const HostSyncResultSchema = z.object({
  stage: z.literal("host-sync"),
  pulls: z.array(
    z.union([
      z.object({ id: z.number().int(), ...PullFacts }),
      z.object({ id: z.number().int(), error: z.string() }),
    ]),
  ),
});

// Every repo whose branch is settled gets its pull request opened, but only when all of them are: a spec's pull
// requests go out together, so that the order they are merged in can be proposed for all of them.
export async function startOpeningPullRequests(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const unsettled = await client.query(
    "SELECT 1 FROM finalizations WHERE spec_id = $1 AND state <> 'done'",
    [specId],
  );
  if (unsettled.rowCount) return;
  const repos = await client.query<{ repo_id: number }>(
    `SELECT f.repo_id FROM finalizations f
     WHERE f.spec_id = $1
       AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.spec_id = f.spec_id AND p.repo_id = f.repo_id)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'open-pr' AND j.state IN ('queued', 'running')
         AND (j.payload->>'specId')::int = f.spec_id AND (j.payload->>'repoId')::int = f.repo_id)
     ORDER BY f.repo_id`,
    [specId],
  );
  for (const { repo_id: repoId } of repos.rows)
    await enqueueOpenPr(client, { specId, repoId });
}

export async function buildHostTask(
  pool: pg.Pool,
  job: { type?: string; payload: Record<string, unknown> },
  payload: OpenPrPayload | HostSyncPayload,
): Promise<HostTask | undefined> {
  if (job.type === "open-pr") {
    const { specId, repoId } = payload as OpenPrPayload;
    const spec = (
      await pool.query<{ slug: string; title: string }>(
        "SELECT slug, title FROM specs WHERE id = $1",
        [specId],
      )
    ).rows[0];
    const repo = (
      await pool.query<{ url: string; default_branch: string }>(
        "SELECT url, default_branch FROM repos WHERE id = $1",
        [repoId],
      )
    ).rows[0];
    if (!spec || !repo) return undefined;
    const tickets = await pool.query<{ id: number; title: string }>(
      "SELECT id, title FROM tickets WHERE spec_id = $1 AND repo_id = $2 AND state = 'done' ORDER BY id",
      [specId, repoId],
    );
    const display = formatDisplayId("spec", specId);
    return {
      kind: "open-pr",
      repoUrl: repo.url,
      base: repo.default_branch,
      head: `spec/${spec.slug}`,
      title: `${display} ${spec.title}`,
      body: [
        `Spec: ${display}`,
        "",
        spec.title,
        "",
        "## Tickets",
        ...tickets.rows.map(
          (t) => `- ${formatDisplayId("ticket", t.id)} ${t.title}`,
        ),
        "",
        "Opened by the AFK platform. Merging is up to you; the platform never merges.",
      ].join("\n"),
      draft: false,
    };
  }
  const { projectId } = payload as HostSyncPayload;
  const pulls = await pool.query<{ id: number; url: string; number: number }>(
    `SELECT p.id, r.url, p.number FROM pull_requests p
     JOIN repos r ON r.id = p.repo_id
     WHERE r.project_id = $1 AND p.state = 'open' ORDER BY p.id`,
    [projectId],
  );
  return {
    kind: "host-sync",
    pulls: pulls.rows.map((p) => ({
      id: p.id,
      repoUrl: p.url,
      number: p.number,
    })),
  };
}

export type RecordHostResult =
  | { status: "applied" }
  | { status: "ignored"; reason: string };

const projectOf = async (client: pg.PoolClient, specId: number) =>
  (
    await client.query<{ project_id: number }>(
      "SELECT project_id FROM specs WHERE id = $1",
      [specId],
    )
  ).rows[0]?.project_id;

// A pull request is open: its repo's finalization is settled for good, and the last one moves the spec on.
export async function recordOpenPr(
  client: pg.PoolClient,
  read: OpenPrPayload,
  result: unknown,
): Promise<RecordHostResult> {
  await lockSpec(client, read.specId);
  const spec = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  if (spec.rows[0]?.state !== "finalizing")
    return {
      status: "ignored",
      reason: `open-pr result for a spec that is ${spec.rows[0]?.state}`,
    };
  const parsed = OpenPrResultSchema.safeParse(result);
  if (!parsed.success) {
    await client.query(
      "UPDATE finalizations SET state = 'blocked', blocked_reason = $3 WHERE spec_id = $1 AND repo_id = $2",
      [read.specId, read.repoId, "invalid-output" satisfies BlockedReason],
    );
    return { status: "ignored", reason: "open-pr result is not valid" };
  }
  const pr = parsed.data;
  await client.query(
    `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, draft, head_sha, ci, review, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (spec_id, repo_id) DO UPDATE SET number = $3, url = $4, state = $5, draft = $6,
       head_sha = $7, ci = $8, review = $9, synced_at = now()`,
    [
      read.specId,
      read.repoId,
      pr.number,
      pr.url,
      pr.state,
      pr.draft,
      pr.headSha,
      pr.ci,
      pr.review,
    ],
  );
  await client.query(
    "UPDATE finalizations SET state = 'done', blocked_reason = NULL WHERE spec_id = $1 AND repo_id = $2",
    [read.specId, read.repoId],
  );
  const missing = await client.query(
    `SELECT 1 FROM finalizations f WHERE f.spec_id = $1
       AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.spec_id = f.spec_id AND p.repo_id = f.repo_id)`,
    [read.specId],
  );
  if (!missing.rowCount) {
    const next = specTransition("finalizing", "pr-opened");
    if (!next.ok) throw new Error(next.reason);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      read.specId,
      next.state,
    ]);
  }
  const projectId = await projectOf(client, read.specId);
  if (projectId !== undefined) await enqueueHostSync(client, projectId);
  return { status: "applied" };
}

// What the host says about the open pull requests of a project. When a person has merged every one of a spec's,
// the spec is merged. While any is still open, the next look is queued a minute from now.
export async function recordHostSync(
  client: pg.PoolClient,
  read: HostSyncPayload,
  result: unknown,
  now: Date,
): Promise<RecordHostResult> {
  const parsed = HostSyncResultSchema.safeParse(result);
  if (!parsed.success) {
    await scheduleNextSync(client, read.projectId, now);
    return { status: "ignored", reason: "host-sync result is not valid" };
  }
  const specs = new Set<number>();
  for (const pull of parsed.data.pulls) {
    if ("error" in pull) continue;
    const updated = await client.query<{ spec_id: number }>(
      `UPDATE pull_requests p SET state = $2, draft = $3, head_sha = $4, ci = $5, review = $6, synced_at = now()
       FROM repos r WHERE p.id = $1 AND r.id = p.repo_id AND r.project_id = $7
       RETURNING p.spec_id`,
      [
        pull.id,
        pull.state,
        pull.draft,
        pull.headSha,
        pull.ci,
        pull.review,
        read.projectId,
      ],
    );
    if (updated.rows[0]) specs.add(updated.rows[0].spec_id);
  }
  for (const specId of [...specs].sort((a, b) => a - b)) {
    await lockSpec(client, specId);
    const open = await client.query(
      "SELECT 1 FROM pull_requests WHERE spec_id = $1 AND state <> 'merged'",
      [specId],
    );
    const state = await client.query<{ state: SpecState }>(
      "SELECT state FROM specs WHERE id = $1",
      [specId],
    );
    if (open.rowCount || state.rows[0]?.state !== "awaiting-review") continue;
    const next = specTransition("awaiting-review", "all-prs-merged");
    if (!next.ok) throw new Error(next.reason);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      specId,
      next.state,
    ]);
  }
  await scheduleNextSync(client, read.projectId, now);
  return { status: "applied" };
}

async function scheduleNextSync(
  client: pg.PoolClient,
  projectId: number,
  now: Date,
) {
  const open = await client.query(
    `SELECT 1 FROM pull_requests p JOIN repos r ON r.id = p.repo_id
     WHERE r.project_id = $1 AND p.state = 'open' LIMIT 1`,
    [projectId],
  );
  if (open.rowCount)
    await enqueueHostSync(
      client,
      projectId,
      new Date(now.getTime() + SYNC_INTERVAL_SECONDS * 1000),
    );
}

// A look at the host that could not be carried out (it was down, the token was refused): try again in a minute.
export const hostSyncFailed = scheduleNextSync;
