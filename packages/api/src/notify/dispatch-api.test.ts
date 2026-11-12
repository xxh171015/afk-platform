import { GIB } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";
import type { Notice } from "./notices.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;
let notices: Notice[];
let freeBytes: number;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  notices = [];
  freeBytes = 20 * GIB;
  clock = new FakeClock();
  api = await listen(
    testApp({
      pool: db.pool,
      clock: clock.now,
      schedule: clock.schedule,
      statDisk: async () => ({ freeBytes, dirBytes: 4096 }),
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
  return new EventStream(response);
}

async function flushWindow() {
  clock.advanceSeconds(30);
  await clock.flush();
}

async function waitForNotices(count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (notices.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(notices).toHaveLength(count);
}

describe("notifications from events", () => {
  it("sends ticket-blocked through the channel after the 30s window, with display id, reason and page link", async () => {
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
      expect(await stream.nextInvalidate()).toMatchObject({
        ticketId: job.payload.ticketId,
        specId: job.payload.specId,
      });
      expect(notices).toEqual([]);
      await flushWindow();
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

  it("does not notify or queue when implement records a conflict", async () => {
    await runningSpec();
    const job = (await worker.claim()).body.job as Claimed;
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {},
          decisions: [
            {
              kind: "conflict",
              text: "ticket vs User Story 6; picked the story",
            },
          ],
        },
      },
    });
    await flushWindow();
    expect(notices).toEqual([]);
    const blocked = (await fetch(`${api.url}/blocked`).then((r) =>
      r.json(),
    )) as { tickets: unknown[] };
    expect(blocked.tickets).toEqual([]);
  });

  it("coalesces the same spec's events in a 30s window, prefers 票卡住 over 需求已合并, and lists each body", async () => {
    const specId = await runningSpec();
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
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await stream.drainInvalidates();
      await db.pool.query("UPDATE specs SET state = 'merged' WHERE id = $1", [
        specId,
      ]);
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      expect(notices).toEqual([]);
      await flushWindow();
      expect(notices).toEqual([
        {
          title: "票卡住",
          body: "T-1 写 CSV：模型放弃\nhttp://127.0.0.1:5173/tickets/1\nS-1 导出订单：已全部合并\nhttp://127.0.0.1:5173/specs/1",
        },
      ]);
    } finally {
      await stream.close();
    }
  });

  it("does not extend the window when another event arrives in the middle", async () => {
    const specId = await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      await db.pool.query(
        "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      clock.advanceSeconds(20);
      await db.pool.query(
        "UPDATE specs SET state = 'awaiting-review', pause_reason = NULL WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      expect(notices).toEqual([]);
      clock.advanceSeconds(10);
      await clock.flush();
      expect(notices).toHaveLength(1);
      expect(notices[0]?.title).toBe("需求已暂停");
      expect(notices[0]?.body).toContain("S-1 导出订单：agent 时间用完");
      expect(notices[0]?.body).toContain("S-1 导出订单：验收包和 PR 已齐");
      clock.advanceSeconds(20);
      await clock.flush();
      expect(notices).toHaveLength(1);
    } finally {
      await stream.close();
    }
  });

  it("sends final-blocked, spec-paused, awaiting-review, pr-ready, spec-merged and waiting-other from those events", async () => {
    const specId = await runningSpec();
    await call("POST", "/projects/1/repos", {
      url: "git@x:frontend",
      name: "frontend",
    });
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();

      await db.pool.query(
        "INSERT INTO finalizations (spec_id, repo_id, step, state, blocked_reason) VALUES ($1, 1, 'final-review', 'blocked', 'job-failed')",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "收尾卡住",
        body: "S-1 导出订单：作业失败\nhttp://127.0.0.1:5173/specs/1/delivery",
      });

      notices.length = 0;
      await db.pool.query(
        "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "需求已暂停",
        body: "S-1 导出订单：agent 时间用完\nhttp://127.0.0.1:5173/specs/1",
      });

      notices.length = 0;
      await db.pool.query(
        "UPDATE specs SET state = 'awaiting-review', pause_reason = NULL WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "可以来验收了",
        body: "S-1 导出订单：验收包和 PR 已齐\nhttp://127.0.0.1:5173/specs/1/delivery",
      });

      notices.length = 0;
      await db.pool.query(
        `INSERT INTO tickets (spec_id, repo_id, type, title, state)
         VALUES ($1, 2, 'implementation', '写 UI', 'pending')`,
        [specId],
      );
      await db.pool.query(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES (1, 2, 'contract')",
      );
      await stream.drainInvalidates();
      await db.pool.query(
        `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, draft, head_sha)
         VALUES ($1, 2, 8, 'http://x/8', 'open', true, 'sha')`,
        [specId],
      );
      await stream.drainInvalidates();
      await db.pool.query(
        "UPDATE pull_requests SET draft = false WHERE spec_id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "PR 已转 ready",
        body: "S-1 导出订单：frontend 的草稿已转 ready\nhttp://127.0.0.1:5173/specs/1/delivery",
      });

      notices.length = 0;
      await db.pool.query(
        "UPDATE pull_requests SET state = 'closed' WHERE spec_id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "待处理",
        body: "S-1 导出订单：PR 被关\nhttp://127.0.0.1:5173/waiting",
      });

      notices.length = 0;
      await db.pool.query("UPDATE specs SET state = 'merged' WHERE id = $1", [
        specId,
      ]);
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices.at(-1)).toEqual({
        title: "需求已合并",
        body: "S-1 导出订单：已全部合并\nhttp://127.0.0.1:5173/specs/1",
      });
    } finally {
      await stream.close();
    }
  });

  it("does not send already-dispatched events again after the API process restarts", async () => {
    const specId = await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      await db.pool.query(
        "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      await flushWindow();
      expect(notices).toHaveLength(1);
    } finally {
      await stream.close();
    }
    await api.close();
    const restarted: Notice[] = [];
    const clock2 = new FakeClock();
    api = await listen(
      testApp({
        pool: db.pool,
        clock: clock2.now,
        schedule: clock2.schedule,
        notifications: {
          async notify(notice) {
            restarted.push(notice);
          },
        },
      }),
    );
    clock2.advanceSeconds(30);
    await clock2.flush();
    expect(restarted).toEqual([]);
    const stream2 = await openEvents();
    try {
      await db.pool.query(
        "UPDATE specs SET state = 'merged', pause_reason = NULL WHERE id = $1",
        [specId],
      );
      expect(await stream2.nextInvalidate()).toMatchObject({ specId });
      clock2.advanceSeconds(30);
      await clock2.flush();
      expect(restarted).toEqual([
        {
          title: "需求已合并",
          body: "S-1 导出订单：已全部合并\nhttp://127.0.0.1:5173/specs/1",
        },
      ]);
    } finally {
      await stream2.close();
    }
  });

  it("inserts a type=system disk event on the edge and notifies once, without a 30s window", async () => {
    freeBytes = 9 * GIB;
    expect((await fetch(`${api.url}/workbench`)).status).toBe(200);
    await waitForNotices(1);
    expect(notices[0]?.title).toBe("磁盘空间不足");
    expect(notices[0]?.body).toContain("剩余不足 10 GiB");
    const events = await db.pool.query(
      "SELECT type, spec_id, data->>'kind' AS kind FROM events WHERE type = 'system'",
    );
    expect(events.rows).toEqual([
      { type: "system", spec_id: null, kind: "disk-warn" },
    ]);
    expect((await fetch(`${api.url}/workbench`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notices).toHaveLength(1);
  });

  it("does not put a system condition into a spec's 30s window", async () => {
    const specId = await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      await db.pool.query(
        "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      expect(notices).toEqual([]);
      freeBytes = 9 * GIB;
      expect((await fetch(`${api.url}/workbench`)).status).toBe(200);
      await waitForNotices(1);
      expect(notices[0]?.title).toBe("磁盘空间不足");
      await flushWindow();
      expect(notices.map((n) => n.title)).toEqual([
        "磁盘空间不足",
        "需求已暂停",
      ]);
    } finally {
      await stream.close();
    }
  });

  it("sends waiting-other for a failed spec-cleanup, after the 30s window", async () => {
    const specId = await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      await db.pool.query(
        `INSERT INTO jobs (type, payload, state, idempotency_key, error)
         VALUES ('spec-cleanup', $1::jsonb, 'failed', 'cleanup-1', 'GitHub answered 503')`,
        [JSON.stringify({ specId })],
      );
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      expect(notices).toEqual([]);
      await flushWindow();
      expect(notices).toEqual([
        {
          title: "待处理",
          body: "S-1 导出订单：清理失败\nhttp://127.0.0.1:5173/waiting",
        },
      ]);
    } finally {
      await stream.close();
    }
  });

  it("does not send waiting-other for a pr-ready failure while a later try is queued, then sends after the last fail", async () => {
    const specId = await runningSpec();
    await call("POST", "/projects/1/repos", {
      url: "git@x:frontend",
      name: "frontend",
    });
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      await db.pool.query(
        `INSERT INTO tickets (spec_id, repo_id, type, title, state)
         VALUES ($1, 2, 'implementation', '写 UI', 'pending')`,
        [specId],
      );
      await db.pool.query(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES (1, 2, 'contract')",
      );
      await stream.drainInvalidates();
      await db.pool.query(
        `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, draft, head_sha)
         VALUES ($1, 2, 8, 'http://x/8', 'open', true, 'sha')`,
        [specId],
      );
      await stream.drainInvalidates();
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO jobs (type, payload, state, idempotency_key, error)
           VALUES ('pr-ready', '{"pullId":1}', 'failed', 'pr-ready-1', '403')`,
        );
        await client.query(
          `INSERT INTO jobs (type, payload, state, idempotency_key)
           VALUES ('pr-ready', '{"pullId":1}', 'queued', 'pr-ready-2')`,
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await stream.drainInvalidates();
      await flushWindow();
      expect(notices).toEqual([]);
      await db.pool.query(
        `INSERT INTO jobs (type, payload, state, idempotency_key, error)
         VALUES ('pr-ready', '{"pullId":1}', 'failed', 'pr-ready-3', '403')`,
      );
      await stream.drainInvalidates();
      expect(notices).toEqual([]);
      await flushWindow();
      expect(notices).toEqual([
        {
          title: "待处理",
          body: "S-1 导出订单：转 ready 三次失败\nhttp://127.0.0.1:5173/waiting",
        },
      ]);
    } finally {
      await stream.close();
    }
  });

  it("inserts a type=system event when agents pause, and does not notify again while still paused", async () => {
    await runningSpec();
    const job = (await worker.claim()).body.job as Claimed;
    const outOfUsage =
      "(FiberFailure) AgentError: cursor exited with code 1:\nActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    expect((await worker.fail(job.id, job.attempt, outOfUsage)).status).toBe(
      200,
    );
    await waitForNotices(1);
    expect(notices[0]?.title).toBe("Agent 已暂停");
    expect(notices[0]?.body).toContain("Cursor 额度用完");
    const events = await db.pool.query(
      "SELECT type, spec_id, data->>'kind' AS kind FROM events WHERE type = 'system'",
    );
    expect(events.rows).toEqual([
      { type: "system", spec_id: null, kind: "agents-paused" },
    ]);
    const other = (await worker.claim()).body.job as Claimed | null;
    if (other) await worker.fail(other.id, other.attempt, outOfUsage);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notices).toHaveLength(1);
  });

  it("does not notify when a person takes a ticket over from the page", async () => {
    await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      expect((await call("POST", "/tickets/1/takeover")).status).toBe(200);
      expect(await stream.nextInvalidate()).toMatchObject({ ticketId: 1 });
      await flushWindow();
      expect(notices).toEqual([]);
    } finally {
      await stream.close();
    }
  });

  it("sends waiting-other when host-sync takes a ticket over because the remote branch moved", async () => {
    await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('afk.source', 'host-sync', true)",
        );
        await client.query(
          "UPDATE tickets SET state = 'taken-over', blocked_reason = NULL WHERE id = 1",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(await stream.nextInvalidate()).toMatchObject({ ticketId: 1 });
      expect(notices).toEqual([]);
      await flushWindow();
      expect(notices).toEqual([
        {
          title: "待处理",
          body: "T-1 写 CSV：票分支已被人改过\nhttp://127.0.0.1:5173/tickets/1",
        },
      ]);
    } finally {
      await stream.close();
    }
  });
});
