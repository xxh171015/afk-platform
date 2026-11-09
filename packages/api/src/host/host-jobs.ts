import { formatDisplayId, HOST_CAPABILITY } from "@afk/shared";
import type pg from "pg";
import { enqueueJob, requeueJob } from "../jobs/queue.ts";

// The jobs that talk to the code host. A worker runs them because the host's credentials live there only
// (docs/design.md「代码托管」): `open-pr` opens one repo's pull request for a spec, `host-sync` follows every
// pull request of a project that is still worth a look (one row per project, put back in the queue after each
// look), `patch-pr-body` writes the acceptance pack into a description. None of them holds a lock key.

export const SYNC_INTERVAL_SECONDS = 60;

// GitLab 429: the worker's error says "retry after Ns". Anything else waits the usual minute.
export function syncDelaySeconds(error?: string): number {
  const match = /retry after (\d+)s/i.exec(error ?? "");
  return match ? Number(match[1]) : SYNC_INTERVAL_SECONDS;
}

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

export interface PatchPrBodyPayload {
  specId: number;
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

export function readPatchPrBodyPayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): PatchPrBodyPayload | undefined {
  const { specId, pullId } = job.payload;
  return job.type === "patch-pr-body" &&
    typeof specId === "number" &&
    typeof pullId === "number"
    ? { specId, pullId }
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

const hostSyncKey = (projectId: number) => `project-${projectId}:host-sync`;

// A project has one host-sync job. Each look puts that same row back in the queue a minute later while a pull
// request is still followed; nothing is queued when it is already waiting or running.
export async function enqueueHostSync(
  client: pg.PoolClient,
  projectId: number,
  notBefore?: Date,
): Promise<boolean> {
  const key = hostSyncKey(projectId);
  const existing = await client.query<{ id: number; state: string }>(
    "SELECT id, state FROM jobs WHERE idempotency_key = $1 FOR UPDATE",
    [key],
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.state === "queued" || row.state === "running") return false;
    await requeueJob(client, row.id, notBefore ?? null);
    return true;
  }
  await enqueueJob(client, {
    type: "host-sync",
    payload: { projectId },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: key,
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

export const patchPrBodyKeyPrefix = ({ specId, pullId }: PatchPrBodyPayload) =>
  `${formatDisplayId("spec", specId)}:pull-${pullId}:pack:`;

// After the acceptance pack is saved, each of the spec's pull requests gets its marked section PATCHed.
export async function enqueuePatchPrBody(
  client: pg.PoolClient,
  payload: PatchPrBodyPayload,
) {
  const prefix = patchPrBodyKeyPrefix(payload);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  return enqueueJob(client, {
    type: "patch-pr-body",
    payload: { ...payload },
    requiredCapabilities: [HOST_CAPABILITY],
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
  });
}

export async function enqueuePackDescriptions(
  client: pg.PoolClient,
  specId: number,
) {
  const pulls = await client.query<{ id: number }>(
    "SELECT id FROM pull_requests WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  for (const pull of pulls.rows)
    await enqueuePatchPrBody(client, { specId, pullId: pull.id });
}
