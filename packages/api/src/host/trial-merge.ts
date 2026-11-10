import { formatDisplayId, type SpecState, TRIAL_MERGE_JOB } from "@afk/shared";
import type pg from "pg";
import { z } from "zod";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";

// Trial-merge (docs/specs/m3-platform.md「trial-merge」): after an integration branch moves, a worker merge-trees
// it against the other specs in the same repo that still have a branch. Conflicts are a hint on both spec pages;
// they do not block, lock, or run a gate. The job has no lock_key and any worker can claim it.

const SPECS_THAT_KEEP_A_BRANCH: SpecState[] = [
  "running",
  "finalizing",
  "awaiting-review",
  "partially-merged",
  "paused",
];

export const TrialMergeResultSchema = z.object({
  stage: z.literal("trial-merge"),
  peers: z.array(
    z.object({
      specId: z.number().int(),
      files: z.array(z.string()),
      ourSha: z.string().min(1),
      theirSha: z.string().min(1),
    }),
  ),
});

export type TrialMergePayload = {
  specId: number;
  repoId: number;
};

export function readTrialMergePayload(job: {
  type: string;
  payload: Record<string, unknown>;
}): TrialMergePayload | undefined {
  if (job.type !== TRIAL_MERGE_JOB) return undefined;
  const { specId, repoId } = job.payload;
  if (typeof specId !== "number" || typeof repoId !== "number")
    return undefined;
  return { specId, repoId };
}

function branchOf(
  branches: { repoId: number; branch: string }[],
  repoId: number,
): string | undefined {
  return branches.find((branch) => branch.repoId === repoId)?.branch;
}

async function livePeers(
  client: Queryable,
  specId: number,
  repoId: number,
): Promise<{ specId: number; branch: string }[]> {
  const { rows } = await client.query<{ spec_id: number; branch: string }>(
    `SELECT s.id AS spec_id, elem->>'branch' AS branch
     FROM specs s
     JOIN LATERAL jsonb_array_elements(s.integration_branches) elem ON true
     WHERE s.id <> $1
       AND s.project_id = (SELECT project_id FROM specs WHERE id = $1)
       AND s.state = ANY($3)
       AND (elem->>'repoId')::int = $2
     ORDER BY s.id`,
    [specId, repoId, SPECS_THAT_KEEP_A_BRANCH],
  );
  return rows
    .filter((row) => row.branch)
    .map((row) => ({ specId: row.spec_id, branch: row.branch }));
}

const trialMergeKeyPrefix = (specId: number, repoId: number) =>
  `${formatDisplayId("spec", specId)}:repo-${repoId}:trial-merge:`;

async function nextTrialMergeKey(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
): Promise<string> {
  const prefix = trialMergeKeyPrefix(specId, repoId);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return `${prefix}${Number(earlier.rows[0]?.n) + 1}`;
}

export async function enqueueTrialMerge(
  client: pg.PoolClient,
  target: { specId: number; repoId: number; headSha?: string },
): Promise<void> {
  const peers = await livePeers(client, target.specId, target.repoId);
  if (peers.length === 0) return;
  const queued = await client.query<{ id: number }>(
    `SELECT id FROM jobs
     WHERE type = $1 AND state = 'queued'
       AND (payload->>'specId')::int = $2 AND (payload->>'repoId')::int = $3
     FOR UPDATE`,
    [TRIAL_MERGE_JOB, target.specId, target.repoId],
  );
  if (queued.rows[0]) {
    if (target.headSha) {
      await client.query(
        `UPDATE jobs SET payload = payload || jsonb_build_object('headSha', $2::text) WHERE id = $1`,
        [queued.rows[0].id, target.headSha],
      );
    }
    return;
  }
  await enqueueJob(client, {
    type: TRIAL_MERGE_JOB,
    payload: {
      stage: "trial-merge",
      specId: target.specId,
      repoId: target.repoId,
      ...(target.headSha ? { headSha: target.headSha } : {}),
    },
    idempotencyKey: await nextTrialMergeKey(
      client,
      target.specId,
      target.repoId,
    ),
  });
}

export async function dropPotentialConflicts(
  client: Queryable,
  specId: number,
): Promise<void> {
  await client.query(
    "DELETE FROM potential_conflicts WHERE spec_id_a = $1 OR spec_id_b = $1",
    [specId],
  );
}

export async function buildTrialMergeTask(
  pool: Queryable,
  payload: TrialMergePayload,
): Promise<
  | {
      spec: { id: number; displayId: string; title: string };
      repo: { name: string; url: string; defaultBranch: string };
      ours: { specId: number; branch: string };
      peers: { specId: number; branch: string }[];
    }
  | undefined
> {
  const spec = await pool.query<{
    id: number;
    title: string;
    integration_branches: { repoId: number; branch: string }[];
  }>("SELECT id, title, integration_branches FROM specs WHERE id = $1", [
    payload.specId,
  ]);
  const repo = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
  }>("SELECT name, url, default_branch FROM repos WHERE id = $1", [
    payload.repoId,
  ]);
  const specRow = spec.rows[0];
  const repoRow = repo.rows[0];
  if (!specRow || !repoRow) return undefined;
  const branch = branchOf(specRow.integration_branches, payload.repoId);
  if (!branch) return undefined;
  return {
    spec: {
      id: specRow.id,
      displayId: formatDisplayId("spec", specRow.id),
      title: specRow.title,
    },
    repo: {
      name: repoRow.name,
      url: repoRow.url,
      defaultBranch: repoRow.default_branch,
    },
    ours: { specId: payload.specId, branch },
    peers: await livePeers(pool, payload.specId, payload.repoId),
  };
}

export type RecordTrialMergeResult =
  | { status: "not-trial-merge" }
  | { status: "ignored"; reason: string }
  | { status: "applied" };

function orderedPair(
  ours: number,
  theirs: number,
  ourSha: string,
  theirSha: string,
): { a: number; b: number; shaA: string; shaB: string } {
  return ours < theirs
    ? { a: ours, b: theirs, shaA: ourSha, shaB: theirSha }
    : { a: theirs, b: ours, shaA: theirSha, shaB: ourSha };
}

export async function recordTrialMergeResult(
  client: pg.PoolClient,
  job: { type: string; payload: Record<string, unknown> },
  result: unknown,
): Promise<RecordTrialMergeResult> {
  const read = readTrialMergePayload(job);
  if (!read) return { status: "not-trial-merge" };
  const parsed = TrialMergeResultSchema.safeParse(result);
  if (!parsed.success)
    return { status: "ignored", reason: "trial-merge result is not valid" };

  const specRow = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [read.specId],
  );
  if (
    !specRow.rows[0] ||
    !SPECS_THAT_KEEP_A_BRANCH.includes(specRow.rows[0].state)
  ) {
    await dropPotentialConflicts(client, read.specId);
    return { status: "applied" };
  }

  const stillThere = new Set(
    (await livePeers(client, read.specId, read.repoId)).map(
      (peer) => peer.specId,
    ),
  );
  await client.query(
    `DELETE FROM potential_conflicts pc
     WHERE pc.repo_id = $2
       AND (pc.spec_id_a = $1 OR pc.spec_id_b = $1)
       AND NOT EXISTS (
         SELECT 1 FROM specs s
         WHERE s.id = CASE WHEN pc.spec_id_a = $1 THEN pc.spec_id_b ELSE pc.spec_id_a END
           AND s.state = ANY($3)
       )`,
    [read.specId, read.repoId, SPECS_THAT_KEEP_A_BRANCH],
  );

  for (const peer of parsed.data.peers) {
    if (peer.specId === read.specId || !stillThere.has(peer.specId)) continue;
    const pair = orderedPair(
      read.specId,
      peer.specId,
      peer.ourSha,
      peer.theirSha,
    );
    if (peer.files.length === 0) {
      await client.query(
        `DELETE FROM potential_conflicts
         WHERE spec_id_a = $1 AND spec_id_b = $2 AND repo_id = $3`,
        [pair.a, pair.b, read.repoId],
      );
      continue;
    }
    await client.query(
      `INSERT INTO potential_conflicts (spec_id_a, spec_id_b, repo_id, files, sha_a, sha_b, discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (spec_id_a, spec_id_b, repo_id)
       DO UPDATE SET files = EXCLUDED.files, sha_a = EXCLUDED.sha_a, sha_b = EXCLUDED.sha_b,
                     discovered_at = now()`,
      [pair.a, pair.b, read.repoId, peer.files, pair.shaA, pair.shaB],
    );
  }
  return { status: "applied" };
}

export interface PotentialConflictView {
  specId: number;
  displayId: string;
  title: string;
  repo: string;
  repoId: number;
  files: string[];
}

export async function potentialConflictsOf(
  pool: Queryable,
  specId: number,
): Promise<PotentialConflictView[]> {
  const { rows } = await pool.query<{
    spec_id: number;
    title: string;
    repo: string;
    repo_id: number;
    files: string[];
  }>(
    `SELECT s.id AS spec_id, s.title, r.name AS repo, r.id AS repo_id, pc.files
     FROM potential_conflicts pc
     JOIN specs s ON s.id = CASE WHEN pc.spec_id_a = $1 THEN pc.spec_id_b ELSE pc.spec_id_a END
     JOIN repos r ON r.id = pc.repo_id
     WHERE pc.spec_id_a = $1 OR pc.spec_id_b = $1
     ORDER BY s.id, r.id`,
    [specId],
  );
  return rows.map((row) => ({
    specId: row.spec_id,
    displayId: formatDisplayId("spec", row.spec_id),
    title: row.title,
    repo: row.repo,
    repoId: row.repo_id,
    files: row.files,
  }));
}
