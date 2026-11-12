import type { InvalidatePayload } from "@afk/shared";
import pg from "pg";

// In-process subscribers of GET /events. The hub is fed from the events table: a LISTEN connection
// catches pg_notify after commit, then reads rows after its id cursor (ADR 0009).

export type InvalidateListener = (payload: InvalidatePayload) => void;

export const EVENTS_CHANNEL = "afk_events";
export const EVENTS_APPLICATION_NAME = "afk-events";

const RECONNECT_MS = 100;

const hubs = new WeakMap<object, EventsHub>();

export function eventsHubOf(app: object): EventsHub | undefined {
  return hubs.get(app);
}

export function bindEventsHub(app: object, hub: EventsHub): void {
  hubs.set(app, hub);
}

export interface EventRow {
  id: number;
  specId: number | null;
  ticketId: number | null;
  runId: number | null;
  jobId: number | null;
  repoId: number | null;
  type: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  data: unknown;
}

export type EventListener = (row: EventRow) => void | Promise<void>;

function payloadOf(row: {
  spec_id: number | null;
  ticket_id: number | null;
  run_id: number | null;
}): InvalidatePayload {
  return {
    ...(row.spec_id != null ? { specId: row.spec_id } : {}),
    ...(row.ticket_id != null ? { ticketId: row.ticket_id } : {}),
    ...(row.run_id != null ? { runId: row.run_id } : {}),
  };
}

function eventRowOf(row: {
  id: string;
  spec_id: number | null;
  ticket_id: number | null;
  run_id: number | null;
  job_id: number | null;
  repo_id: number | null;
  type: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  data: unknown;
}): EventRow {
  return {
    id: Number(row.id),
    specId: row.spec_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    jobId: row.job_id,
    repoId: row.repo_id,
    type: row.type,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    data: row.data,
  };
}

export class EventsHub {
  private readonly listeners = new Set<InvalidateListener>();
  private readonly eventListeners = new Set<EventListener>();
  private pool: pg.Pool | undefined;
  private client: pg.Client | undefined;
  private cursor = "0";
  private primed = false;
  private stopped = true;
  private ready: Promise<void> = Promise.resolve();
  private pump: Promise<void> = Promise.resolve();

  subscribe(listener: InvalidateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  publish(payload: InvalidatePayload): void {
    for (const listener of this.listeners) listener(payload);
  }

  listen(pool: pg.Pool): Promise<void> {
    this.stopped = false;
    this.pool = pool;
    this.ready = this.connect();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pool = undefined;
    await this.releaseClient();
    try {
      await this.ready;
    } catch {
      // connect failed or the database went away while stopping
    }
  }

  private async connect(): Promise<void> {
    while (!this.stopped && this.pool) {
      try {
        const client = new pg.Client({
          connectionString: this.pool.options.connectionString,
          host: this.pool.options.host,
          port: this.pool.options.port,
          user: this.pool.options.user,
          password: this.pool.options.password,
          database: this.pool.options.database,
          application_name: EVENTS_APPLICATION_NAME,
        });
        client.on("error", () => {
          this.recover(client);
        });
        client.on("end", () => {
          this.recover(client);
        });
        await client.connect();
        if (this.stopped) {
          await client.end();
          return;
        }
        this.client = client;
        if (!this.primed) {
          const { rows } = await client.query<{ id: string | null }>(
            "SELECT max(id)::text AS id FROM events",
          );
          this.cursor = rows[0]?.id ?? "0";
          this.primed = true;
        }
        await client.query(`LISTEN ${EVENTS_CHANNEL}`);
        client.on("notification", (message) => {
          if (message.channel === EVENTS_CHANNEL) this.enqueueCatchUp();
        });
        await this.catchUp();
        return;
      } catch {
        await this.releaseClient();
        if (this.stopped || !this.pool) return;
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
      }
    }
  }

  private recover(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    void client.end().catch(() => undefined);
    if (this.stopped || !this.pool) return;
    this.ready = new Promise((resolve) =>
      setTimeout(resolve, RECONNECT_MS),
    ).then(() => this.connect());
  }

  private enqueueCatchUp(): void {
    this.pump = this.pump.then(() => this.catchUp()).catch(() => undefined);
  }

  private async catchUp(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    const { rows } = await client.query<{
      id: string;
      spec_id: number | null;
      ticket_id: number | null;
      run_id: number | null;
      job_id: number | null;
      repo_id: number | null;
      type: string;
      from_state: string | null;
      to_state: string | null;
      reason: string | null;
      data: unknown;
    }>(
      `SELECT id::text AS id, spec_id, ticket_id, run_id, job_id, repo_id, type,
              from_state, to_state, reason, data
       FROM events WHERE id > $1::bigint ORDER BY id`,
      [this.cursor],
    );
    for (const row of rows) {
      this.cursor = row.id;
      // Dispatcher ingest finishes before SSE, so a client that saw invalidate has a scheduled window.
      await this.emitEvent(eventRowOf(row));
      this.publish(payloadOf(row));
    }
  }

  private async emitEvent(row: EventRow): Promise<void> {
    for (const listener of this.eventListeners) {
      try {
        await listener(row);
      } catch (error) {
        console.error("event listener failed:", error);
      }
    }
  }

  private async releaseClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    client.removeAllListeners();
    try {
      await client.end();
    } catch {
      // already closed
    }
  }
}
