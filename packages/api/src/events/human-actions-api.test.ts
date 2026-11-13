import { hostname } from "node:os";
import { type Io, run } from "@afk/cli";
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

// A person's every action is an event too, written with the action (docs/specs/m3-platform.md「事件表」).

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  const clock = new FakeClock();
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
}

// Every queued implement job gives up: each ticket is blocked by its agent.
async function blockAll() {
  for (;;) {
    const job = (await worker.claim()).body.job;
    if (!job) return;
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "agent-gave-up",
    });
  }
}

const actions = async (where = "TRUE") =>
  (
    await db.pool.query(
      `SELECT spec_id, ticket_id, source, data FROM events WHERE type = 'action' AND ${where} ORDER BY id`,
    )
  ).rows;

describe("a person's actions", () => {
  it("are the same event from the page and from plat, but for the source", async () => {
    await runningSpec(["a", "b"]);
    await blockAll();
    await call("POST", "/tickets/1/retry", {
      mode: "continue",
      note: "look at the config",
    });
    await plat("ticket", "retry", "T-2", "--mode", "continue");
    expect(await actions("ticket_id IS NOT NULL")).toEqual([
      {
        spec_id: 1,
        ticket_id: 1,
        source: "page",
        data: {
          action: "retry",
          mode: "continue",
          note: "look at the config",
          host: hostname(),
        },
      },
      {
        spec_id: 1,
        ticket_id: 2,
        source: "cli",
        data: { action: "retry", mode: "continue", host: hostname() },
      },
    ]);
  });

  it("let a ticket's history be read in order: who did what, when", async () => {
    await runningSpec(["a"]);
    await blockAll();
    await call("POST", "/tickets/1/allow-paths", { paths: ["docs/**"] });
    const file = (await call("GET", "/tickets/1")).body.ticket.file as string;
    await call("POST", "/tickets/1/edit", {
      file: file.replace("title: Ticket a", "title: Ticket A"),
    });
    await plat("ticket", "cancel", "T-1");
    const history = await db.pool.query(
      `SELECT at, source, data->>'action' AS action FROM events
       WHERE type = 'action' AND ticket_id = 1 ORDER BY at, id`,
    );
    expect(history.rows.map((r) => [r.source, r.action])).toEqual([
      ["page", "allow-paths"],
      ["page", "edit-ticket"],
      ["cli", "cancel-ticket"],
    ]);
    expect(history.rows.every((r) => r.at instanceof Date)).toBe(true);
  });

  it("include confirming, retrying, allowing and cancelling a spec", async () => {
    await runningSpec(["a"]);
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = 1",
    );
    expect(
      (await call("POST", "/specs/1/resume", { extraSeconds: 3600 })).status,
    ).toBe(200);
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'update-branch-conflict' WHERE id = 1",
    );
    expect((await call("POST", "/specs/1/allow")).status).toBe(200);
    await plat("spec", "cancel", "S-1");
    expect(
      (await actions()).map((e) => [e.source, e.data.action, e.ticket_id]),
    ).toEqual([
      ["page", "confirm", null],
      ["page", "retry", null],
      ["page", "allow", null],
      ["cli", "cancel-spec", null],
    ]);
    expect((await actions())[1].data.extraSeconds).toBe(3600);
  });

  it("are not recorded when the action is refused", async () => {
    await runningSpec(["a"]);
    // T-1 is queued, not blocked: nothing to retry
    expect(
      (await call("POST", "/tickets/1/retry", { mode: "continue" })).status,
    ).toBe(409);
    expect(await actions("ticket_id IS NOT NULL")).toEqual([]);
  });

  it("records takeover from the page and from plat, but for the source", async () => {
    await runningSpec(["a", "b"]);
    expect((await call("POST", "/tickets/1/takeover")).status).toBe(200);
    await plat("ticket", "takeover", "T-2");
    expect(await actions("ticket_id IS NOT NULL")).toEqual([
      {
        spec_id: 1,
        ticket_id: 1,
        source: "page",
        data: { action: "takeover", host: hostname() },
      },
      {
        spec_id: 1,
        ticket_id: 2,
        source: "cli",
        data: { action: "takeover", host: hostname() },
      },
    ]);
  });
});
