import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import type { Notice } from "../notify/notices.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";
import { EVENTS_APPLICATION_NAME } from "./hub.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let notices: Notice[];

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  notices = [];
  api = await listen(
    testApp({
      pool: db.pool,
      sseKeepaliveMs: 40,
      notifications: {
        async notify(notice) {
          notices.push(notice);
        },
      },
    }),
  );
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api?.close();
  await db?.drop();
});

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId: number; specId: number };
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { id: number },
  };
}

async function runningSpec() {
  const created = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "s",
    title: "导出订单",
  });
  expect(
    (
      await call(
        "POST",
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, {
          tickets: [
            {
              key: "a",
              repo: "backend",
              type: "implementation",
              title: "写 CSV",
              modules: ["src/a/**"],
              acceptance: ["it works"],
            },
          ],
        }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
    200,
  );
  return spec.body.id;
}

class EventStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private pending:
    | ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
    | undefined;
  constructor(response: Response) {
    const body = response.body;
    if (!body) throw new Error("no body");
    this.reader = body.getReader();
  }

  private async pull(timeoutMs: number): Promise<void> {
    this.pending ??= this.reader.read();
    const result = await Promise.race([
      this.pending.then((chunk) => ({ kind: "chunk" as const, chunk })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
      ),
    ]);
    if (result.kind === "timeout") return;
    this.pending = undefined;
    if (result.chunk.value) {
      this.buffer += this.decoder.decode(result.chunk.value, { stream: true });
    }
  }

  async nextInvalidate(timeoutMs = 2_000): Promise<Record<string, number>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const parsed = this.takeInvalidate();
      if (parsed) return parsed;
      await this.pull(deadline - Date.now());
    }
    throw new Error(`no invalidate in ${this.buffer}`);
  }

  async nextComment(timeoutMs = 2_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.buffer.match(/^: (.*)\n\n/m);
      if (match) {
        this.buffer = this.buffer.slice((match.index ?? 0) + match[0].length);
        return match[1];
      }
      await this.pull(deadline - Date.now());
    }
    throw new Error(`no comment in ${this.buffer}`);
  }

  private takeInvalidate(): Record<string, number> | undefined {
    const match = this.buffer.match(/event: invalidate\ndata: (\{.*\})\n\n/);
    if (!match) return undefined;
    this.buffer = this.buffer.slice((match.index ?? 0) + match[0].length);
    return JSON.parse(match[1] as string) as Record<string, number>;
  }

  async drainInvalidates(quietMs = 150): Promise<void> {
    for (;;) {
      try {
        await this.nextInvalidate(quietMs);
      } catch {
        return;
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function openEvents(): Promise<EventStream> {
  const response = await fetch(`${api.url}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  return new EventStream(response);
}

async function insertEvent(ids: {
  specId?: number | null;
  ticketId?: number | null;
  runId?: number | null;
}): Promise<void> {
  await db.pool.query(
    `INSERT INTO events (spec_id, ticket_id, run_id, type)
     VALUES ($1, $2, $3, 'action')`,
    [ids.specId ?? null, ids.ticketId ?? null, ids.runId ?? null],
  );
}

describe("GET /events", () => {
  it("streams an invalidate whose ids are those of the event just written", async () => {
    const stream = await openEvents();
    try {
      await insertEvent({ specId: 7, ticketId: 11, runId: 13 });
      expect(await stream.nextInvalidate()).toEqual({
        specId: 7,
        ticketId: 11,
        runId: 13,
      });
    } finally {
      await stream.close();
    }
  });

  it("streams an empty invalidate when the event has no spec, ticket or run", async () => {
    const stream = await openEvents();
    try {
      await insertEvent({});
      expect(await stream.nextInvalidate()).toEqual({});
    } finally {
      await stream.close();
    }
  });

  it("does not replay a missed event when the browser opens a new /events stream", async () => {
    const first = await openEvents();
    try {
      await insertEvent({ specId: 2 });
      expect(await first.nextInvalidate()).toEqual({ specId: 2 });
    } finally {
      await first.close();
    }
    const second = await openEvents();
    try {
      await expect(second.nextInvalidate(150)).rejects.toThrow(/no invalidate/);
    } finally {
      await second.close();
    }
  });

  it("streams invalidate from a spec created over HTTP, matching the event's spec id", async () => {
    const stream = await openEvents();
    try {
      const created = await call("POST", "/projects", { name: "shop" });
      await call("POST", `/projects/${created.body.id}/repos`, {
        url: "git@x:backend",
        role: "backend",
      });
      const spec = await call("POST", "/specs", {
        projectId: created.body.id,
        type: "feature",
        slug: "s",
        title: "导出订单",
      });
      expect(spec.status).toBe(201);
      expect(await stream.nextInvalidate()).toEqual({ specId: spec.body.id });
    } finally {
      await stream.close();
    }
  });

  it("does not stream an invalidate until the writing transaction commits", async () => {
    const stream = await openEvents();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO events (spec_id, type) VALUES (8, 'action')`,
      );
      await expect(stream.nextInvalidate(150)).rejects.toThrow(/no invalidate/);
      await client.query("COMMIT");
      expect(await stream.nextInvalidate()).toEqual({ specId: 8 });
    } finally {
      client.release();
      await stream.close();
    }
  });

  it("still streams an event written while listening was down, once listening again", async () => {
    const stream = await openEvents();
    try {
      await db.pool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1`,
        [EVENTS_APPLICATION_NAME],
      );
      await insertEvent({ specId: 4, ticketId: 5, runId: 6 });
      expect(await stream.nextInvalidate()).toEqual({
        specId: 4,
        ticketId: 5,
        runId: 6,
      });
    } finally {
      await stream.close();
    }
  });

  it("streams invalidate when a ticket run starts, and a keepalive comment", async () => {
    await runningSpec();
    const stream = await openEvents();
    try {
      const job = (await worker.claim()).body.job as Claimed;
      const payload = await stream.nextInvalidate();
      expect(payload.ticketId).toBe(job.payload.ticketId);
      expect(payload.specId).toBe(job.payload.specId);
      expect(await stream.nextComment()).toBe("keepalive");
    } finally {
      await stream.close();
    }
  });

  it("does not stream invalidate when a log chunk is appended", async () => {
    await runningSpec();
    const job = (await worker.claim()).body.job as Claimed;
    const run = await db.pool.query<{ id: number }>(
      "SELECT id FROM runs WHERE job_id = $1",
      [job.id],
    );
    const stream = await openEvents();
    try {
      const appended = await fetch(
        `${api.url}/worker/runs/${run.rows[0].id}/logs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workerId: worker.id,
            attempt: job.attempt,
            chunk: "hello\n",
          }),
        },
      );
      expect(appended.status).toBe(200);
      await expect(stream.nextInvalidate(150)).rejects.toThrow(/no invalidate/);
    } finally {
      await stream.close();
    }
  });
});

describe("notifications on a visible transition", () => {
  it("notifies once when a ticket enters blocked, with the page URL", async () => {
    await runningSpec();
    const stream = await openEvents();
    try {
      const job = (await worker.claim()).body.job as Claimed;
      await stream.drainInvalidates();
      await worker.complete(job.id, job.attempt, {
        stage: "implement",
        outcome: "agent-gave-up",
        run: {
          output: {
            status: "cannot-proceed",
            blockedReason: "agent-gave-up",
            detail: "needs a decision",
          },
        },
      });
      const payload = await stream.nextInvalidate();
      expect(payload.ticketId).toBe(job.payload.ticketId);
      expect(payload.specId).toBe(job.payload.specId);
      const detail = (await (
        await fetch(`${api.url}/tickets/${job.payload.ticketId}`)
      ).json()) as {
        ticket: { structuredBrief: { summary: string } };
      };
      const summary = detail.ticket.structuredBrief.summary;
      expect(summary).toBe("模型放弃");
      expect(notices).toEqual([
        {
          title: "票卡住",
          body: `T-1 写 CSV：${summary}\nhttp://127.0.0.1:5173/tickets/1`,
        },
      ]);
    } finally {
      await stream.close();
    }
  });
});
