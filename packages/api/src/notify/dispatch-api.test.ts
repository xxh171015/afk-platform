import { GIB } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
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
  db = await createMigratedTestDatabase();
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
        body: "S-1 导出订单：验收包和 PR 已齐\nhttp://127.0.0.1:5173/specs/1/review",
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

describe("ticket-level needs-human notifications", () => {
  const knownGap = {
    outcome: "done",
    run: {
      output: {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [
          {
            kind: "known-gap",
            text: "reload still skips the note filter",
          },
        ],
      },
    },
  };

  async function stage(expected: string, result: Record<string, unknown>) {
    const claimed = (await worker.claim()).body.job as Claimed | null;
    expect(claimed?.payload.stage).toBe(expected);
    const job = claimed as Claimed;
    const reply = await worker.complete(job.id, job.attempt, {
      stage: expected,
      ...result,
    });
    expect(reply.status).toBe(200);
    return job;
  }

  async function decisionIdOf(job: Claimed): Promise<string> {
    const bundle = (await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
    ).then((r) => r.json())) as {
      decisionLog: { ticket: { decisions: { id: string }[] } };
    };
    return bundle.decisionLog.ticket.decisions[0]?.id as string;
  }

  async function passReviewWithNeedsHuman() {
    await stage("implement", knownGap);
    await stage("gate", { outcome: "passed" });
    const review = (await worker.claim()).body.job as Claimed;
    expect(review.payload.stage).toBe("review");
    const id = await decisionIdOf(review);
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: [],
          rulings: [{ id, verdict: "needs-human" }],
        },
      },
    });
    return { review, id };
  }

  async function flushNeedsHumanWindow() {
    clock.advanceSeconds(5 * 60);
    await clock.flush();
  }

  it("ticket-level review with needs-human records an event and notifies, without changing spec state or blocking the next stage", async () => {
    const specId = await runningSpec();
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      const { id, review } = await passReviewWithNeedsHuman();
      const spec = await db.pool.query<{ state: string }>(
        "SELECT state FROM specs WHERE id = $1",
        [specId],
      );
      expect(spec.rows[0]?.state).toBe("running");
      const ticket = await db.pool.query<{ state: string }>(
        "SELECT state FROM tickets WHERE spec_id = $1",
        [specId],
      );
      expect(ticket.rows[0]?.state).toBe("merging");
      const blocked = (await fetch(`${api.url}/blocked`).then((r) =>
        r.json(),
      )) as { tickets: unknown[] };
      expect(blocked.tickets).toEqual([]);
      const next = (await worker.claim()).body.job as Claimed | null;
      expect(next?.payload.stage).toBe("merge");
      const runId = (
        await db.pool.query<{ id: number }>(
          "SELECT id FROM runs WHERE job_id = $1",
          [review.id],
        )
      ).rows[0]?.id;
      const events = await db.pool.query<{
        type: string;
        ticket_id: number | null;
        run_id: number | null;
        kind: string | null;
        decision_id: string | null;
        decision_text: string | null;
      }>(
        `SELECT type, ticket_id, run_id, data->>'kind' AS kind,
                data->'decisions'->0->>'id' AS decision_id,
                data->'decisions'->0->>'text' AS decision_text
         FROM events WHERE data->>'kind' = 'needs-human'`,
      );
      expect(events.rows).toEqual([
        {
          type: "ticket",
          ticket_id: 1,
          run_id: runId,
          kind: "needs-human",
          decision_id: id,
          decision_text: "reload still skips the note filter",
        },
      ]);
      await stream.drainInvalidates();
      expect(notices).toEqual([]);
      await flushNeedsHumanWindow();
      expect(notices).toHaveLength(1);
      expect(notices[0]?.title).toBe("票级审查需要人定");
      expect(notices[0]?.body).toContain("T-1 写 CSV");
      expect(notices[0]?.body).toContain(`R-${runId}`);
      expect(notices[0]?.body).toContain(id);
      expect(notices[0]?.body).toContain("reload still skips the note filter");
      expect(notices[0]?.body).toContain("plat tickets import --append");
      expect(notices[0]?.body).toContain("plat spec edit --ref");
      expect(notices[0]?.body).toContain("plat ticket retry");
    } finally {
      await stream.close();
    }
  });

  it("does not record a needs-human event or notify when ticket-level review has no needs-human ruling", async () => {
    await runningSpec();
    await stage("implement", knownGap);
    await stage("gate", { outcome: "passed" });
    const review = (await worker.claim()).body.job as Claimed;
    expect(review.payload.stage).toBe("review");
    const id = await decisionIdOf(review);
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: [],
          rulings: [{ id, verdict: "accepted" }],
        },
      },
    });
    const events = await db.pool.query(
      "SELECT 1 FROM events WHERE data->>'kind' = 'needs-human'",
    );
    expect(events.rows).toEqual([]);
    await flushNeedsHumanWindow();
    expect(notices).toEqual([]);
  });

  it("does not send the ticket-level needs-human notice when final-review returns needs-human", async () => {
    await runningSpec();
    await stage("implement", knownGap);
    await stage("gate", { outcome: "passed" });
    const review = (await worker.claim()).body.job as Claimed;
    expect(review.payload.stage).toBe("review");
    const id = await decisionIdOf(review);
    await worker.complete(review.id, review.attempt, {
      stage: "review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: [],
          rulings: [{ id, verdict: "accepted" }],
        },
      },
    });
    await stage("merge", { outcome: "merged", headSha: "head-1" });
    const finalReview = (await worker.claim()).body.job as Claimed;
    expect(finalReview.payload.stage).toBe("final-review");
    await worker.complete(finalReview.id, finalReview.attempt, {
      stage: "final-review",
      outcome: "pass",
      run: {
        axis: "spec",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: [],
          rulings: [{ id, verdict: "needs-human" }],
        },
      },
    });
    const events = await db.pool.query(
      "SELECT 1 FROM events WHERE data->>'kind' = 'needs-human'",
    );
    expect(events.rows).toEqual([]);
    await flushNeedsHumanWindow();
    expect(
      notices.filter((notice) => notice.title === "票级审查需要人定"),
    ).toEqual([]);
  });

  it("coalesces two tickets' needs-human on the same spec within 5 minutes into one notice", async () => {
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
              {
                key: "b",
                repo: "backend",
                type: "implementation",
                title: "写 UI",
                modules: ["src/b/**"],
                acceptance: ["it works"],
                blocked_by: ["a"],
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
      200,
    );
    const stream = await openEvents();
    try {
      await stream.drainInvalidates();
      const first = await passReviewWithNeedsHuman();
      await stream.drainInvalidates();
      clock.advanceSeconds(60);
      await clock.flush();
      expect(notices).toEqual([]);
      await stage("merge", { outcome: "merged", headSha: "head-1" });
      await stream.drainInvalidates();
      const second = await passReviewWithNeedsHuman();
      await stream.drainInvalidates();
      clock.advanceSeconds(4 * 60);
      await clock.flush();
      expect(notices).toHaveLength(1);
      expect(notices[0]?.title).toBe("票级审查需要人定");
      expect(notices[0]?.body).toContain("T-1 写 CSV");
      expect(notices[0]?.body).toContain(first.id);
      expect(notices[0]?.body).toContain("T-2 写 UI");
      expect(notices[0]?.body).toContain(second.id);
    } finally {
      await stream.close();
    }
  });
});
