import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import type { Notice } from "../notify/notices.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let notices: Notice[];

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  notices = [];
  api = await listen(
    createApp({
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
  constructor(response: Response) {
    const body = response.body;
    if (!body) throw new Error("no body");
    this.reader = body.getReader();
  }

  async nextInvalidate(timeoutMs = 2_000): Promise<Record<string, number>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const parsed = this.takeInvalidate();
      if (parsed) return parsed;
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            remaining,
          ),
        ),
      ]);
      if (chunk.value)
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
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
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            remaining,
          ),
        ),
      ]);
      if (chunk.value)
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    throw new Error(`no comment in ${this.buffer}`);
  }

  private takeInvalidate(): Record<string, number> | undefined {
    const match = this.buffer.match(/event: invalidate\ndata: (\{.*\})\n\n/);
    if (!match) return undefined;
    this.buffer = this.buffer.slice((match.index ?? 0) + match[0].length);
    return JSON.parse(match[1] as string) as Record<string, number>;
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

describe("GET /events", () => {
  it("streams invalidate when a ticket run starts, and a keepalive comment", async () => {
    await runningSpec();
    const stream = await openEvents();
    const job = (await worker.claim()).body.job as Claimed;
    const payload = await stream.nextInvalidate();
    expect(payload.ticketId).toBe(job.payload.ticketId);
    expect(payload.specId).toBe(job.payload.specId);
    expect(payload.runId).toEqual(expect.any(Number));
    expect(await stream.nextComment()).toBe("keepalive");
    await stream.close();
  });

  it("does not stream invalidate when a log chunk is appended", async () => {
    await runningSpec();
    const job = (await worker.claim()).body.job as Claimed;
    const run = await db.pool.query<{ id: number }>(
      "SELECT id FROM runs WHERE job_id = $1",
      [job.id],
    );
    const stream = await openEvents();
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
    await stream.close();
  });
});

describe("notifications on a visible transition", () => {
  it("notifies once when a ticket enters blocked, with the page URL", async () => {
    await runningSpec();
    const stream = await openEvents();
    const job = (await worker.claim()).body.job as Claimed;
    await stream.nextInvalidate();
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
    expect(payload.runId).toEqual(expect.any(Number));
    expect(notices).toEqual([
      {
        title: "票卡住",
        body: "T-1 写 CSV：模型放弃\nhttp://127.0.0.1:5173/tickets/1",
      },
    ]);
    await stream.close();
  });
});
