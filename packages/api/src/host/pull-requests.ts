import {
  type BlockedReason,
  branchNames,
  formatDisplayId,
  type SpecState,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { readAcceptancePack, saveAcceptancePack } from "../acceptance/pack.ts";
import { renderPackSection } from "../acceptance/pack-description.ts";
import { lockSpec } from "../scheduling/scheduler.ts";
import {
  enqueueHostSync,
  enqueueOpenPr,
  enqueuePrReady,
  enqueueSpecCleanup,
  type HostSyncPayload,
  type OpenPrPayload,
  type PatchPrBodyPayload,
  type PrReadyPayload,
  type SpecCleanupPayload,
  SYNC_INTERVAL_SECONDS,
  syncDelaySeconds,
} from "./host-jobs.ts";
import { mergeOrderOf } from "./merge-order.ts";
import {
  applyDefaultShas,
  defaultBranchesOfRunningSpecs,
  projectHasRunningSpecs,
} from "./update-branch.ts";

// A spec's pull requests: opened once its repos are all finalized, then followed until a person has merged them
// all. The platform only records what the host says; it has no call that merges (docs/design.md「代码托管」).

// The pull requests still worth a look: not merged, and of a spec that is not over. One closed without merge stays in,
// so that a reopen or a merge is noticed. Written for queries that alias the pull request `p` and its spec `s`.
export const FOLLOWED_PULL_REQUESTS = `p.state <> 'merged' AND s.state NOT IN ('merged', 'cancelled')`;

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
      defaults: { repoUrl: string; branch: string }[];
    }
  | {
      kind: "pr-ready";
      pull: { id: number; repoUrl: string; number: number };
    }
  | {
      kind: "spec-cleanup";
      pulls: { id: number; repoUrl: string; number: number }[]; // last seen open: to be closed
      branches: { repoUrl: string; branch: string }[]; // to be deleted
    }
  | {
      kind: "patch-pr-body";
      repoUrl: string;
      number: number;
      section: string;
      summary: string;
    };

const PullFacts = {
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  headSha: z.string().min(1),
  ci: z.enum(["none", "pending", "success", "failure"]),
  review: z.enum(["none", "approved", "changes-requested"]),
  mergedBy: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  mergedByPlatform: z.boolean().optional(),
};

export const OpenPrResultSchema = z.object({
  stage: z.literal("open-pr"),
  outcome: z.literal("opened"),
  number: z.number().int().min(1),
  url: z.string().min(1),
  ...PullFacts,
});

export const PrReadyResultSchema = z.object({
  stage: z.literal("pr-ready"),
  ...PullFacts,
});

export const SpecCleanupResultSchema = z.object({
  stage: z.literal("spec-cleanup"),
  closed: z.array(z.number().int()), // pull request ids the worker closed
});

export const HostSyncResultSchema = z.object({
  stage: z.literal("host-sync"),
  pulls: z.array(
    z.union([
      z.object({ id: z.number().int(), ...PullFacts }),
      z.object({ id: z.number().int(), error: z.string() }),
    ]),
  ),
  defaults: z
    .array(
      z.object({
        repoUrl: z.string().min(1),
        sha: z.string().min(1),
      }),
    )
    .optional(),
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
  payload:
    | OpenPrPayload
    | HostSyncPayload
    | SpecCleanupPayload
    | PrReadyPayload
    | PatchPrBodyPayload,
): Promise<HostTask | undefined> {
  if (job.type === "patch-pr-body") {
    const { specId, pullId } = payload as PatchPrBodyPayload;
    const pull = (
      await pool.query<{ url: string; number: number; repo: string }>(
        `SELECT r.url, p.number, r.name AS repo
         FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.id = $1`,
        [pullId],
      )
    ).rows[0];
    const pack = await readAcceptancePack(pool, specId);
    if (!pull || !pack) return undefined;
    const rendered = renderPackSection(pack, pull.repo, specId);
    return {
      kind: "patch-pr-body",
      repoUrl: pull.url,
      number: pull.number,
      section: rendered.section,
      summary: rendered.summary,
    };
  }
  if (job.type === "spec-cleanup")
    return specCleanupTask(pool, payload as SpecCleanupPayload);
  if (job.type === "pr-ready") {
    const { pullId } = payload as PrReadyPayload;
    const pull = (
      await pool.query<{ id: number; url: string; number: number }>(
        `SELECT p.id, r.url, p.number FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.id = $1`,
        [pullId],
      )
    ).rows[0];
    return pull
      ? {
          kind: "pr-ready",
          pull: { id: pull.id, repoUrl: pull.url, number: pull.number },
        }
      : undefined;
  }
  if (job.type === "open-pr") {
    const { specId, repoId } = payload as OpenPrPayload;
    const spec = (
      await pool.query<{
        slug: string;
        title: string;
        branch_namespace: string | null;
      }>("SELECT slug, title, branch_namespace FROM specs WHERE id = $1", [
        specId,
      ])
    ).rows[0];
    const repo = (
      await pool.query<{ url: string; default_branch: string; name: string }>(
        "SELECT url, default_branch, name FROM repos WHERE id = $1",
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
      head: branchNames(spec.branch_namespace).integration(spec.slug),
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
      // a repo that uses another repo's contract is merged after it, and says so by being a draft until then
      draft:
        ((await mergeOrderOf(pool, specId)).after[repo.name] ?? []).length > 0,
    };
  }
  const { projectId } = payload as HostSyncPayload;
  const pulls = await pool.query<{ id: number; url: string; number: number }>(
    `SELECT p.id, r.url, p.number FROM pull_requests p
     JOIN repos r ON r.id = p.repo_id JOIN specs s ON s.id = p.spec_id
     WHERE r.project_id = $1 AND ${FOLLOWED_PULL_REQUESTS} ORDER BY p.id`,
    [projectId],
  );
  return {
    kind: "host-sync",
    pulls: pulls.rows.map((p) => ({
      id: p.id,
      repoUrl: p.url,
      number: p.number,
    })),
    defaults: await defaultBranchesOfRunningSpecs(pool, projectId),
  };
}

// A spec's pull requests that were last seen open, and the branches it made in every repo it touched: the
// integration branch, one per ticket, and the one an overall fix is made on. Nothing else is ever named here.
async function specCleanupTask(
  pool: pg.Pool,
  { specId }: SpecCleanupPayload,
): Promise<HostTask | undefined> {
  const spec = (
    await pool.query<{ slug: string; branch_namespace: string | null }>(
      "SELECT slug, branch_namespace FROM specs WHERE id = $1",
      [specId],
    )
  ).rows[0];
  if (!spec) return undefined;
  const open = await pool.query<{ id: number; url: string; number: number }>(
    `SELECT p.id, r.url, p.number FROM pull_requests p JOIN repos r ON r.id = p.repo_id
     WHERE p.spec_id = $1 AND p.state = 'open' ORDER BY p.id`,
    [specId],
  );
  const repos = await pool.query<{ id: number; url: string }>(
    `SELECT r.id, r.url FROM repos r WHERE r.id IN (
       SELECT repo_id FROM tickets WHERE spec_id = $1
       UNION SELECT repo_id FROM pull_requests WHERE spec_id = $1
       UNION SELECT repo_id FROM finalizations WHERE spec_id = $1
       UNION SELECT planning_repo_id FROM specs WHERE id = $1 AND planning_repo_id IS NOT NULL
       UNION SELECT (b->>'repoId')::int FROM specs s, jsonb_array_elements(s.integration_branches) b
        WHERE s.id = $1) ORDER BY r.id`,
    [specId],
  );
  const tickets = await pool.query<{ id: number; repo_id: number }>(
    "SELECT id, repo_id FROM tickets WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const names = branchNames(spec.branch_namespace);
  const branches = repos.rows.flatMap((repo) => [
    { repoUrl: repo.url, branch: names.integration(spec.slug) },
    ...tickets.rows
      .filter((t) => t.repo_id === repo.id)
      .map((t) => ({
        repoUrl: repo.url,
        branch: names.ticket(formatDisplayId("ticket", t.id)),
      })),
    {
      repoUrl: repo.url,
      branch: names.final(formatDisplayId("spec", specId)),
    },
  ]);
  return {
    kind: "spec-cleanup",
    pulls: open.rows.map((p) => ({
      id: p.id,
      repoUrl: p.url,
      number: p.number,
    })),
    branches,
  };
}

// The worker closed these pull requests: the platform does not wait for the next look at the host to know.
export async function recordSpecCleanup(
  client: pg.PoolClient,
  read: SpecCleanupPayload,
  result: unknown,
): Promise<RecordHostResult> {
  const parsed = SpecCleanupResultSchema.safeParse(result);
  if (!parsed.success)
    return { status: "ignored", reason: "spec-cleanup result is not valid" };
  // Spec lock first, as in recordHostSync: a look at the host that was under way must not write `open` over this.
  await lockSpec(client, read.specId);
  await client.query(
    "UPDATE pull_requests SET state = 'closed', synced_at = now() WHERE spec_id = $1 AND id = ANY($2::int[]) AND state = 'open'",
    [read.specId, parsed.data.closed],
  );
  return { status: "applied" };
}

// The worker turned a draft pull request ready (or found it already so): the platform does not wait for the next
// look at the host to know.
export async function recordPrReady(
  client: pg.PoolClient,
  read: PrReadyPayload,
  result: unknown,
): Promise<RecordHostResult> {
  const parsed = PrReadyResultSchema.safeParse(result);
  if (!parsed.success)
    return { status: "ignored", reason: "pr-ready result is not valid" };
  const owner = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM pull_requests WHERE id = $1",
    [read.pullId],
  );
  const specId = owner.rows[0]?.spec_id;
  if (specId === undefined)
    return { status: "ignored", reason: "no such pull request" };
  await lockSpec(client, specId);
  const pr = parsed.data;
  await client.query(
    `UPDATE pull_requests SET state = $2, draft = $3, head_sha = $4, ci = $5, review = $6, sync_error = NULL, synced_at = now()
     WHERE id = $1`,
    [read.pullId, pr.state, pr.draft, pr.headSha, pr.ci, pr.review],
  );
  await markMergedWhenAllAre(client, specId);
  return { status: "applied" };
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
  now: Date,
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
    // the pack is ready by the time the spec says it is waiting for a person
    await saveAcceptancePack(client, read.specId, now);
    const next = specTransition("finalizing", "pr-opened");
    if (!next.ok) throw new Error(next.reason);
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      read.specId,
      next.state,
    ]);
    // a pull request that was already merged when it was found (opened by an earlier try) may be the last one
    await markMergedWhenAllAre(client, read.specId);
  }
  const projectId = await projectOf(client, read.specId);
  if (projectId !== undefined) await enqueueHostSync(client, projectId);
  return { status: "applied" };
}

// What the merges of a spec's pull requests mean for the spec (the spec is locked): the first one makes it
// partially merged, and when a person has merged every one it is merged and its clean-up is queued. A repo merged
// before the repos it waits for is noted on the spec, for good: the order was broken, and the spec goes on.
async function markMergedWhenAllAre(client: pg.PoolClient, specId: number) {
  const pulls = await client.query<{ name: string; state: string }>(
    `SELECT r.name, p.state FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.spec_id = $1`,
    [specId],
  );
  const state = await client.query<{
    state: SpecState;
    order_broken: { repo: string; skipped: string[] }[];
  }>("SELECT state, order_broken FROM specs WHERE id = $1", [specId]);
  const spec = state.rows[0];
  if (!spec || !["awaiting-review", "partially-merged"].includes(spec.state))
    return;
  const merged = new Set(
    pulls.rows.filter((p) => p.state === "merged").map((p) => p.name),
  );
  if (merged.size === 0) return;

  const order = await mergeOrderOf(client, specId);
  const broken = [...spec.order_broken];
  for (const repo of merged) {
    const skipped = (order.after[repo] ?? []).filter((r) => !merged.has(r));
    if (skipped.length > 0 && !broken.some((b) => b.repo === repo))
      broken.push({ repo, skipped });
  }
  if (broken.length !== spec.order_broken.length)
    await client.query("UPDATE specs SET order_broken = $2 WHERE id = $1", [
      specId,
      JSON.stringify(broken),
    ]);

  const all = pulls.rows.every((p) => p.state === "merged");
  // still partially merged, and still not all: nothing moves
  if (spec.state === "partially-merged" && !all) return;
  const next = specTransition(
    spec.state,
    all ? "all-prs-merged" : "some-prs-merged",
  );
  if (!next.ok) throw new Error(next.reason);
  await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
    specId,
    next.state,
  ]);
  if (all) await enqueueSpecCleanup(client, { specId });
}

// What the host says about the open pull requests of a project. When a person has merged every one of a spec's,
// the spec is merged. While any is still followed (see above), the same host-sync job is put back in the queue a
// minute from now.
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
  // Spec lock first, as everywhere else: lock the specs these pull requests belong to before touching their rows.
  const owners = await client.query<{ spec_id: number }>(
    `SELECT DISTINCT p.spec_id FROM pull_requests p JOIN repos r ON r.id = p.repo_id
     WHERE p.id = ANY($1::int[]) AND r.project_id = $2 ORDER BY p.spec_id`,
    [parsed.data.pulls.map((p) => p.id), read.projectId],
  );
  for (const { spec_id: specId } of owners.rows) await lockSpec(client, specId);
  for (const pull of parsed.data.pulls) {
    if ("error" in pull) {
      // kept on the row, so that a pull request the host keeps refusing is not silent
      await client.query(
        `UPDATE pull_requests p SET sync_error = $2, synced_at = now() FROM repos r
         WHERE p.id = $1 AND r.id = p.repo_id AND r.project_id = $3`,
        [pull.id, pull.error, read.projectId],
      );
      continue;
    }
    const mergedAt =
      pull.mergedAt != null && !Number.isNaN(Date.parse(pull.mergedAt))
        ? pull.mergedAt
        : null;
    await client.query(
      `UPDATE pull_requests p SET state = $2, draft = $3, head_sha = $4, ci = $5, review = $6, sync_error = NULL, synced_at = now(),
         merged_at = COALESCE($8::timestamptz, merged_at), merged_by = COALESCE($9, merged_by)
       FROM repos r WHERE p.id = $1 AND r.id = p.repo_id AND r.project_id = $7`,
      [
        pull.id,
        pull.state,
        pull.draft,
        pull.headSha,
        pull.ci,
        pull.review,
        read.projectId,
        mergedAt,
        pull.mergedBy ?? null,
      ],
    );
    if (pull.mergedByPlatform)
      await client.query(
        `UPDATE specs SET token_merged = true FROM pull_requests p
         WHERE specs.id = p.spec_id AND p.id = $1 AND NOT specs.token_merged`,
        [pull.id],
      );
  }
  for (const { spec_id: specId } of owners.rows) {
    await markMergedWhenAllAre(client, specId);
    await queueReadyPullRequests(client, specId);
  }
  if (parsed.data.defaults)
    await applyDefaultShas(client, read.projectId, parsed.data.defaults);
  await scheduleNextSync(client, read.projectId, now);
  return { status: "applied" };
}

// A draft pull request goes ready once every pull request it is behind (the repos whose contracts its repo uses) is
// merged. One a person has already turned ready is not a draft any more and is left alone; one that has had a job
// (waiting, running, failed or done) is not queued again by this: a failed one waits in plat blocked for a person,
// and one the host still shows as a draft after a job succeeded is not asked again every minute.
async function queueReadyPullRequests(client: pg.PoolClient, specId: number) {
  const order = await mergeOrderOf(client, specId);
  const pulls = await client.query<{
    id: number;
    name: string;
    state: string;
    draft: boolean;
  }>(
    `SELECT p.id, r.name, p.state, p.draft FROM pull_requests p JOIN repos r ON r.id = p.repo_id
     WHERE p.spec_id = $1 ORDER BY p.id`,
    [specId],
  );
  const mergedRepos = new Set(
    pulls.rows.filter((p) => p.state === "merged").map((p) => p.name),
  );
  for (const pull of pulls.rows) {
    if (pull.state !== "open" || !pull.draft) continue;
    const before = order.after[pull.name] ?? [];
    if (before.length === 0 || !before.every((name) => mergedRepos.has(name)))
      continue;
    const pending = await client.query(
      `SELECT 1 FROM jobs WHERE type = 'pr-ready' AND (payload->>'pullId')::int = $1
         AND state IN ('queued', 'running', 'failed', 'done') LIMIT 1`,
      [pull.id],
    );
    if (!pending.rowCount) await enqueuePrReady(client, { pullId: pull.id });
  }
}

async function scheduleNextSync(
  client: pg.PoolClient,
  projectId: number,
  now: Date,
  delaySeconds = SYNC_INTERVAL_SECONDS,
) {
  const open = await client.query(
    `SELECT 1 FROM pull_requests p JOIN repos r ON r.id = p.repo_id JOIN specs s ON s.id = p.spec_id
     WHERE r.project_id = $1 AND ${FOLLOWED_PULL_REQUESTS} LIMIT 1`,
    [projectId],
  );
  const running = await projectHasRunningSpecs(client, projectId);
  if (open.rowCount || running)
    await enqueueHostSync(
      client,
      projectId,
      new Date(now.getTime() + delaySeconds * 1000),
    );
}

// A look at the host that could not be carried out (it was down, the token was refused): try again in a minute,
// or after Retry-After when GitLab answered 429.
export function hostSyncFailed(
  client: pg.PoolClient,
  projectId: number,
  now: Date,
  error?: string,
) {
  return scheduleNextSync(client, projectId, now, syncDelaySeconds(error));
}
