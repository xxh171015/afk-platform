import { AsyncLocalStorage } from "node:async_hooks";
import type { EventSource } from "@afk/shared";
import type pg from "pg";

// Who is making the changes of the current request or pass, for the events the database writes with them
// (drizzle/0035_events.sql). A transaction hands it to the triggers as transaction-local settings.

export interface EventOrigin {
  source: EventSource;
  // the job a worker is reporting on: the events of its transaction belong to that job's Run
  jobId?: number;
  // the machine a person acted from (the page's is the API's own: M3 runs both on one Mac)
  host?: string;
}

const current = new AsyncLocalStorage<EventOrigin>();

export function withOrigin<T>(origin: EventOrigin, work: () => T): T {
  return current.run(origin, work);
}

export function currentOrigin(): EventOrigin | undefined {
  return current.getStore();
}

// Inside a transaction: tell the triggers who it is. A change made outside one is recorded without a source.
export async function applyOrigin(
  client: Pick<pg.PoolClient, "query">,
  origin: EventOrigin | undefined = currentOrigin(),
): Promise<void> {
  if (!origin) return;
  await setOrigin(
    client,
    origin.source,
    origin.jobId === undefined ? "" : String(origin.jobId),
  );
}

const setOrigin = (
  client: Pick<pg.PoolClient, "query">,
  source: string,
  jobId: string,
) =>
  client.query(
    "SELECT set_config('afk.source', $1, true), set_config('afk.job_id', $2, true)",
    [source, jobId],
  );

// Part of a transaction done on someone else's behalf (a scheduling pass inside a worker's report): its events
// carry that source and no job, and the transaction's own origin is put back afterwards.
export async function asSource<T>(
  client: Pick<pg.PoolClient, "query">,
  source: EventSource,
  work: () => Promise<T>,
): Promise<T> {
  const { rows } = await client.query<{ source: string; job: string }>(
    `SELECT COALESCE(current_setting('afk.source', true), '') AS source,
            COALESCE(current_setting('afk.job_id', true), '') AS job`,
  );
  const saved = rows[0] ?? { source: "", job: "" };
  await setOrigin(client, source, "");
  try {
    return await work();
  } finally {
    await setOrigin(client, saved.source, saved.job);
  }
}
