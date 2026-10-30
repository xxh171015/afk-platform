import { formatDisplayId, HOST_CAPABILITY } from "@afk/shared";
import type pg from "pg";
import { enqueueJob } from "../jobs/queue.ts";

// The jobs that talk to the code host. A worker runs them because the host's credentials live there only
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
export interface SpecCleanupPayload {
  specId: number;
}

export interface PrReadyPayload {
  pullId: number;
}

export function readPrReadyPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): PrReadyPayload | undefined {
  const { pullId } = job.payload;
  return job.type === "pr-ready" && typeof pullId === "number"
    ? { pullId }
    : undefined;
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

export function readSpecCleanupPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): SpecCleanupPayload | undefined {
  const { specId } = job.payload;
  return job.type === "spec-cleanup" && typeof specId === "number"
    ? { specId }
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

export const specCleanupKeyPrefix = ({ specId }: SpecCleanupPayload) =>
  `${formatDisplayId("spec", specId)}:cleanup:`;

// A spec that is cancelled or merged: its open pull requests are closed and its branches deleted, by a worker that
// holds the host's credentials. A second one (after a failure) gets the next sequence.
export async function enqueueSpecCleanup(
  client: pg.PoolClient,
  payload: SpecCleanupPayload,
  notBefore?: Date,
) {
  const prefix = specCleanupKeyPrefix(payload);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return enqueueJob(client, {
    type: "spec-cleanup",
    payload: { ...payload },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
    ...(notBefore ? { notBefore } : {}),
  });
}

// A cancelled spec's cleanup starts only after a lease (120 s) and a heartbeat (30 s): the jobs the cancel stopped
// may still be running in their sandboxes, but each is refused at its next heartbeat, and a push or a result of
// it is refused by the fence, so after this nothing of the spec is being made any more.
export const CLEANUP_GRACE_SECONDS = 150;
// A failed cleanup is tried again after this, so that a short outage of the host does not use up all three tries.
export const CLEANUP_RETRY_SECONDS = 60;

export const inSeconds = (now: Date, seconds: number) =>
  new Date(now.getTime() + seconds * 1000);

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

export const prReadyKeyPrefix = ({ pullId }: PrReadyPayload) =>
  `pull-${pullId}:pr-ready:`;

// A draft pull request whose prerequisites are merged is to be turned ready by a worker with the host's credentials.
// A second one (after a failure) gets the next sequence, and waits `notBefore` so that a short outage of the host
// does not use up all three tries.
export async function enqueuePrReady(
  client: pg.PoolClient,
  payload: PrReadyPayload,
  notBefore?: Date,
) {
  const prefix = prReadyKeyPrefix(payload);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return enqueueJob(client, {
    type: "pr-ready",
    payload: { ...payload },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
    ...(notBefore ? { notBefore } : {}),
  });
}
