import { formatDisplayId, HOST_CAPABILITY } from "@afk/shared";
import type pg from "pg";
import { enqueueJob } from "../jobs/queue.ts";

// The two jobs that talk to the code host. A worker runs them because the host's credentials live there only
// (docs/design.md「代码托管」): `open-pr` opens one repo's pull request for a spec, `host-sync` looks at every
// pull request of a project that is still open. Neither holds a lock key.

export const SYNC_INTERVAL_SECONDS = 60;

export interface OpenPrPayload {
  specId: number;
  repoId: number;
}
export interface HostSyncPayload {
  projectId: number;
}

export function readOpenPrPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): OpenPrPayload | undefined {
  const { specId, repoId } = job.payload;
  return job.type === "open-pr" &&
    typeof specId === "number" &&
    typeof repoId === "number"
    ? { specId, repoId }
    : undefined;
}

export function readHostSyncPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): HostSyncPayload | undefined {
  const { projectId } = job.payload;
  return job.type === "host-sync" && typeof projectId === "number"
    ? { projectId }
    : undefined;
}

export const openPrKeyPrefix = ({ specId, repoId }: OpenPrPayload) =>
  `${formatDisplayId("spec", specId)}:repo-${repoId}:open-pr:`;

// One more try: a second open-pr for the same spec and repo (after a person retried) gets the next sequence.
export async function enqueueOpenPr(
  client: pg.PoolClient,
  payload: OpenPrPayload,
) {
  const prefix = openPrKeyPrefix(payload);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return enqueueJob(client, {
    type: "open-pr",
    payload: { ...payload },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
  });
}

// A project has one host-sync chain: each run queues the next one a minute later while a pull request is open.
// Nothing is queued when one is already waiting or running.
export async function enqueueHostSync(
  client: pg.PoolClient,
  projectId: number,
  notBefore?: Date,
): Promise<boolean> {
  const active = await client.query(
    `SELECT 1 FROM jobs WHERE type = 'host-sync' AND state IN ('queued', 'running')
       AND (payload->>'projectId')::int = $1`,
    [projectId],
  );
  if (active.rowCount) return false;
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE type = 'host-sync' AND (payload->>'projectId')::int = $1",
    [projectId],
  );
  await enqueueJob(client, {
    type: "host-sync",
    payload: { projectId },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `project-${projectId}:host-sync:${Number(earlier.rows[0]?.n) + 1}`,
    ...(notBefore ? { notBefore } : {}),
  });
  return true;
}
