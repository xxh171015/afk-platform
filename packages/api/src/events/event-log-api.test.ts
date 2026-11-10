import { type Io, run } from "@afk/cli";
import {
  EXTERNAL_ERROR_PATTERNS,
  failureSourceOf,
  REASON_CODES,
} from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

// The event log (docs/specs/m3-platform.md「事件表」): every state change is an event, written with the change.

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(testApp({ pool: db.pool, clock: clock.now }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;
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
  return { status: response.status, body: (await response.json()) as Json };
}

const ticket = (key: string) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
});

async function runningSpec(keys: string[]) {
  const created = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "s",
    title: "Spec",
  });
  await call(
    "POST",
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, { tickets: keys.map(ticket) }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

// Another ticket's jobs met on the way are left running and handed back.
async function failThreeTimes(error: string, ticketId = 1) {
  const others: Claimed[] = [];
  for (let i = 0; i < 3; i++) {
    let job = await claim();
    while (job && job.payload.ticketId !== ticketId) {
      others.push(job);
      job = await claim();
    }
    if (!job) throw new Error(`no job for T-${ticketId}`);
    expect((await worker.fail(job.id, job.attempt, error)).status).toBe(200);
  }
  return others;
}

const eventsOf = async (type: string, ticketId?: number) =>
  (
    await db.pool.query(
      `SELECT from_state, to_state, reason, source, failure_source, run_id, job_id
       FROM events WHERE type = $1 AND ($2::int IS NULL OR ticket_id = $2) ORDER BY id`,
      [type, ticketId ?? null],
    )
  ).rows;

describe("the events of a ticket", () => {
  it("records each change of its state with who made it", async () => {
    await runningSpec(["a"]);
    await failThreeTimes("sandbox exited with code 137");
    const lastRun = (
      await db.pool.query("SELECT id FROM runs ORDER BY id DESC LIMIT 1")
    ).rows[0].id;
    expect(await eventsOf("ticket", 1)).toEqual([
      expect.objectContaining({ from_state: null, to_state: "pending" }),
      expect.objectContaining({
        from_state: "pending",
        to_state: "queued",
        source: "scheduler",
      }),
      expect.objectContaining({
        from_state: "queued",
        to_state: "running",
        source: "worker",
      }),
      {
        from_state: "running",
        to_state: "blocked",
        reason: "job-failed",
        source: "worker",
        failure_source: "platform",
        run_id: lastRun,
        job_id: expect.any(Number),
      },
    ]);
  });

  it("puts a block on an outside service when the job's error names one", async () => {
    await runningSpec(["a"]);
    await failThreeTimes("GitHub answered 502 reading pull request 3");
    const blocked = (await eventsOf("ticket", 1)).at(-1);
    expect(blocked).toMatchObject({
      to_state: "blocked",
      failure_source: "external",
    });
  });

  it("records each failed job, a failure the platform recovered from by queueing it again", async () => {
    await runningSpec(["a"]);
    const job = (await claim()) as Claimed;
    await worker.fail(job.id, job.attempt, "npm error code EAI_AGAIN");
    expect(
      (await eventsOf("job", 1)).filter((e) => e.to_state === "failed"),
    ).toEqual([
      expect.objectContaining({
        from_state: "running",
        reason: "job-failed",
        failure_source: "external",
        source: "worker",
        job_id: job.id,
        run_id: expect.any(Number),
      }),
    ]);
  });

  it("records a lease that ran out as a platform failure", async () => {
    await runningSpec(["a"]);
    const job = (await claim()) as Claimed;
    clock.advanceSeconds(10_000);
    await claim();
    expect(
      (await eventsOf("job", 1)).filter((e) => e.reason === "lease-expired"),
    ).toEqual([
      expect.objectContaining({
        from_state: "running",
        to_state: "queued",
        failure_source: "platform",
        job_id: job.id,
      }),
    ]);
  });

  it("leaves no event when the change is rolled back", async () => {
    await runningSpec(["a"]);
    const before = (
      await db.pool.query("SELECT count(*)::int AS n FROM events")
    ).rows[0].n;
    await expect(
      inTransaction(db.pool, async (client) => {
        await client.query(
          "UPDATE tickets SET state = 'cancelled' WHERE id = 1",
        );
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n,
    ).toBe(before);
  });
});

describe("who made a change", () => {
  async function plat(...args: string[]) {
    const io: Io = {
      stdout: () => {},
      stderr: () => {},
      env: { AFK_API_URL: api.url },
      readFile: async () => "",
      readDirectory: async () => [],
    };
    expect(await run(args, io)).toBe(0);
  }
  const specEvents = async () =>
    (
      await db.pool.query(
        "SELECT from_state, to_state, source FROM events WHERE type = 'spec' ORDER BY id",
      )
    ).rows;

  it("is the page, or the CLI when plat made it", async () => {
    await runningSpec(["a"]);
    expect((await specEvents())[0]).toMatchObject({
      to_state: "draft",
      source: "page",
    });
    await plat("spec", "cancel", "S-1");
    expect((await specEvents()).at(-1)).toEqual({
      from_state: "running",
      to_state: "cancelled",
      source: "cli",
    });
  });

  it("does not count the jobs a person's cancel stopped as failures", async () => {
    await runningSpec(["a"]);
    await claim();
    await plat("spec", "cancel", "S-1");
    const stopped = (await eventsOf("job", 1)).filter(
      (e) => e.to_state === "failed",
    );
    expect(stopped).toEqual([
      expect.objectContaining({
        reason: null,
        failure_source: null,
        source: "cli",
      }),
    ]);
  });
});

describe("the failure source the database works out", () => {
  const errors = [
    null,
    "",
    "GitHub answered 502 reading pull request 12",
    "GitLab did not describe the token's user: HTTP 401",
    "GitHub answered 404 reading pull request 512",
    "GitHub refused to mark pull request 3 ready (503): x",
    "cursor-agent: Authentication required",
    "HTTP 429 Too Many Requests",
    "getaddrinfo ENOTFOUND registry.npmmirror.com",
    "net/http: TLS handshake timeout",
    "sandbox exited with code 137",
  ];

  it("agrees with @afk/shared on every reason code and error", async () => {
    for (const reason of [...REASON_CODES, null]) {
      for (const error of errors) {
        const { rows } = await db.pool.query(
          "SELECT afk_failure_source($1, $2) AS source",
          [reason, error],
        );
        const expected =
          reason === null ? null : failureSourceOf(reason, error);
        expect(rows[0].source, `${reason} / ${error}`).toBe(expected);
      }
    }
  });

  it("knows the same outside-service patterns", async () => {
    const { rows } = await db.pool.query(
      "SELECT pg_get_functiondef('afk_failure_source(text, text)'::regprocedure) AS body",
    );
    for (const pattern of EXTERNAL_ERROR_PATTERNS)
      expect(rows[0].body).toContain(`'${pattern}'`);
  });
});

describe("the waiting queue", () => {
  it("puts the platform's and outside services' problems in a group of their own, after the spec's", async () => {
    await runningSpec(["a", "b"]);
    // T-1 is blocked first, by the platform; T-2 by its agent
    const [job] = await failThreeTimes("sandbox exited with code 137", 1);
    if (!job) throw new Error("T-2 was not claimed");
    expect(job.payload.ticketId).toBe(2);
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "agent-gave-up",
    });
    const queue = (await call("GET", "/blocked")).body;
    expect(queue.items).toEqual([
      { kind: "ticket", id: 2 },
      { kind: "ticket", id: 1 },
    ]);
    expect(
      queue.tickets.map((t: Json) => [t.id, t.failureSource]).sort(),
    ).toEqual([
      [1, "platform"],
      [2, "agent"],
    ]);
  });
});
