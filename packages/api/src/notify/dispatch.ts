import type pg from "pg";
import type { EventRow, EventsHub } from "../events/hub.ts";
import type { NotificationChannel } from "./channel.ts";
import { type MappedNotice, noticeFromEvent } from "./from-event.ts";
import { composeWindow, type NoticeDraft } from "./notices.ts";

export const NOTICE_WINDOW_MS = 30_000;

const dispatchers = new WeakMap<object, NotificationDispatcher>();

export function dispatcherOf(app: object): NotificationDispatcher | undefined {
  return dispatchers.get(app);
}

export function bindDispatcher(
  app: object,
  dispatcher: NotificationDispatcher,
): void {
  dispatchers.set(app, dispatcher);
}

interface Window {
  items: MappedNotice[];
  firstEventId: number;
  specId: number;
  cancel: () => void;
}

interface DispatcherOptions {
  pool: pg.Pool;
  hub: EventsHub;
  notifications: NotificationChannel;
  schedule: (ms: number, fn: () => unknown) => () => void;
}

export class NotificationDispatcher {
  private cursor = 0;
  private started = false;
  private booting = false;
  private ready: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private readonly windows = new Map<number, Window>();
  private chain: Promise<void> = Promise.resolve();
  private readonly queuedLive: EventRow[] = [];
  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    if (this.started) return this.ready;
    this.started = true;
    this.ready = this.runStart();
    return this.ready;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const window of this.windows.values()) window.cancel();
    this.windows.clear();
    try {
      await this.ready;
    } catch {
      // start failed while stopping
    }
    await this.chain.catch(() => undefined);
    await this.persistCursor().catch(() => undefined);
  }

  private async runStart(): Promise<void> {
    await this.options.hub.whenReady();
    const last = await this.options.pool.query<{
      last_notified_event_id: string | number | null;
    }>("SELECT last_notified_event_id FROM instance");
    const stored = last.rows[0]?.last_notified_event_id;
    this.cursor = stored == null || stored === "" ? 0 : Number(stored);
    if (!Number.isFinite(this.cursor)) this.cursor = 0;
    this.booting = true;
    this.unsubscribe = this.options.hub.subscribeEvents((row) => {
      if (this.booting) {
        this.queuedLive.push(row);
        return;
      }
      return this.enqueue(() => this.ingest(row));
    });
    await this.catchUp();
    this.booting = false;
    const live = this.queuedLive.splice(0);
    for (const row of live) await this.ingest(row);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch((error) => {
      console.error("notification dispatcher failed:", error);
    });
    return this.chain;
  }

  private async catchUp(): Promise<void> {
    const { rows } = await this.options.pool.query<{
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
      source: string | null;
      data: unknown;
    }>(
      `SELECT id::text AS id, spec_id, ticket_id, run_id, job_id, repo_id, type, from_state, to_state, reason, source, data
       FROM events WHERE id > $1::bigint ORDER BY id`,
      [this.cursor],
    );
    for (const row of rows) await this.ingest(eventRowOf(row));
  }

  private async ingest(row: EventRow): Promise<void> {
    if (row.id <= this.cursor) return;
    const mapped = await noticeFromEvent(this.options.pool, row);
    if (!mapped) {
      this.cursor = row.id;
      return;
    }
    const specId = mapped.specId ?? row.specId;
    if (specId == null) {
      this.cursor = row.id;
      await this.options.notifications.notify(mapped.notice, {
        eventId: row.id,
        projectId: mapped.projectId,
      });
      await this.persistCursor();
      return;
    }
    this.cursor = row.id;
    this.enqueueWindow(specId, mapped, row.id);
    await this.persistCursor();
  }

  private enqueueWindow(
    specId: number,
    mapped: MappedNotice,
    eventId: number,
  ): void {
    const existing = this.windows.get(specId);
    if (existing) {
      existing.items.push(mapped);
      return;
    }
    const window: Window = {
      items: [mapped],
      firstEventId: eventId,
      specId,
      cancel: this.options.schedule(NOTICE_WINDOW_MS, () =>
        this.enqueue(() => this.flush(specId)),
      ),
    };
    this.windows.set(specId, window);
  }

  private async flush(specId: number): Promise<void> {
    const window = this.windows.get(specId);
    if (!window) return;
    this.windows.delete(specId);
    window.cancel();
    const drafts: NoticeDraft[] = window.items.flatMap((item) =>
      item.draft ? [item.draft] : [],
    );
    if (drafts.length === 0) return;
    const hostKind = window.items[0]?.hostKind ?? "github";
    const notice = composeWindow(drafts, hostKind);
    await this.options.notifications.notify(notice, {
      eventId: window.firstEventId,
      projectId: window.items[0]?.projectId,
    });
  }

  private async persistCursor(): Promise<void> {
    await this.options.pool.query(
      `UPDATE instance SET last_notified_event_id = $1::bigint
       WHERE last_notified_event_id IS NULL OR last_notified_event_id < $1::bigint`,
      [this.cursor],
    );
  }
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
  source: string | null;
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
    source: row.source,
    data: row.data,
  };
}
