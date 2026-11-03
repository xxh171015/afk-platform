import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeClock, listen, type RunningApi } from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(createApp({ pool: db.pool, clock: clock.now }));
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
  return {
    status: response.status,
    body: (await response.json()) as Json,
  };
}

const ticketFile = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works", "it is fast"],
  ...extra,
});

async function projectAndRepo(name = "shop") {
  const created = await call("POST", "/projects", { name });
  const projectId = created.body.id as number;
  await call("POST", `/projects/${projectId}/repos`, {
    url: "git@x:backend",
    name: "backend",
  });
  return projectId;
}

async function confirmedSpec(
  projectId: number,
  slug: string,
  title: string,
  tickets: Record<string, unknown>[],
) {
  const spec = await call("POST", "/specs", {
    projectId,
    type: "feature",
    slug,
    title,
  });
  const specId = spec.body.id as number;
  expect(
    (
      await call(
        "POST",
        `/specs/${specId}/tickets/import`,
        importBody(specId, { tickets }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${specId}/confirm`)).status).toBe(200);
  return specId;
}

describe("GET /workbench", () => {
  it("returns four empty quadrants when the database is empty", async () => {
    const reply = await call("GET", "/workbench");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      waiting: {
        tickets: [],
        finalizations: [],
        pullRequests: [],
        cleanups: [],
        readyFailures: [],
        specs: [],
      },
      running: [],
      awaitingAcceptance: [],
      recentlyCompleted: [],
    });
  });

  it("puts blocked tickets and the rest of the waiting queue in waiting", async () => {
    const projectId = await projectAndRepo();
    const specId = await confirmedSpec(projectId, "s", "Stuck spec", [
      ticketFile("a"),
    ]);
    const view = await call("GET", `/specs/${specId}`);
    const ticketId = view.body.tickets[0].id as number;
    await db.pool.query(
      "UPDATE tickets SET state = 'blocked', blocked_reason = 'agent-gave-up' WHERE id = $1",
      [ticketId],
    );
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'the agent time limit of the spec was reached' WHERE id = $1",
      [specId],
    );

    const reply = await call("GET", "/workbench");
    expect(reply.status).toBe(200);
    expect(reply.body.waiting.tickets).toEqual([
      expect.objectContaining({
        id: ticketId,
        displayId: `T-${ticketId}`,
        state: "blocked",
        blockedReason: "agent-gave-up",
      }),
    ]);
    expect(reply.body.waiting.specs).toEqual([
      {
        id: specId,
        displayId: `S-${specId}`,
        title: "Stuck spec",
        reason: "the agent time limit of the spec was reached",
      },
    ]);
    expect(reply.body.running).toEqual([]);
  });

  it("lists running specs with the current stage, elapsed time and 偏慢 from project history", async () => {
    const projectId = await projectAndRepo();
    const historyId = await confirmedSpec(projectId, "old", "Old", [
      ticketFile("old"),
    ]);
    await db.pool.query("UPDATE specs SET state = 'merged' WHERE id = $1", [
      historyId,
    ]);
    await db.pool.query("UPDATE tickets SET state = 'done'");
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, duration_ms, started_at, finished_at)
       VALUES ($1, 1, 'implement', $2, $3, $4)`,
      [
        historyId,
        10 * 60 * 1000,
        new Date(clock.now().getTime() - 2 * 3600 * 1000),
        new Date(clock.now().getTime() - 3600 * 1000),
      ],
    );

    const specId = await confirmedSpec(projectId, "now", "Now", [
      ticketFile("now"),
    ]);
    const view = await call("GET", `/specs/${specId}`);
    const ticketId = view.body.tickets[0].id as number;
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = $1", [
      ticketId,
    ]);
    const started = new Date(clock.now().getTime() - 25 * 60 * 1000);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, started_at)
       VALUES ($1, 1, $2, 'implement', $3)`,
      [specId, ticketId, started],
    );

    const reply = await call("GET", "/workbench");
    expect(reply.status).toBe(200);
    expect(reply.body.running).toEqual([
      {
        spec: expect.objectContaining({
          id: specId,
          displayId: `S-${specId}`,
          title: "Now",
          state: "running",
          project: "shop",
        }),
        tickets: [
          {
            id: ticketId,
            displayId: `T-${ticketId}`,
            title: "Ticket now",
            state: "running",
            repo: "backend",
            stage: "implement",
            startedAt: started.toISOString(),
            elapsedMs: 25 * 60 * 1000,
            meanMs: 10 * 60 * 1000,
            slow: true,
          },
        ],
      },
    ]);
  });

  it("does not mark 偏慢 when the project has no finished run of that stage", async () => {
    const projectId = await projectAndRepo();
    const specId = await confirmedSpec(projectId, "now", "Now", [
      ticketFile("now"),
    ]);
    const view = await call("GET", `/specs/${specId}`);
    const ticketId = view.body.tickets[0].id as number;
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = $1", [
      ticketId,
    ]);
    const started = new Date(clock.now().getTime() - 3 * 3600 * 1000);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, started_at)
       VALUES ($1, 1, $2, 'implement', $3)`,
      [specId, ticketId, started],
    );

    const ticket = (await call("GET", "/workbench")).body.running[0].tickets[0];
    expect(ticket).toMatchObject({
      stage: "implement",
      elapsedMs: 3 * 3600 * 1000,
      meanMs: null,
      slow: false,
    });
  });

  it("does not use another project's history for 偏慢", async () => {
    const shop = await projectAndRepo("shop");
    const other = await projectAndRepo("other");
    const historyId = await confirmedSpec(other, "old", "Old", [
      ticketFile("old"),
    ]);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, duration_ms, started_at, finished_at)
       VALUES ($1, (SELECT id FROM repos WHERE project_id = $2), 'implement', 60000, $3, $4)`,
      [
        historyId,
        other,
        new Date(clock.now().getTime() - 120_000),
        new Date(clock.now().getTime() - 60_000),
      ],
    );

    const specId = await confirmedSpec(shop, "now", "Now", [ticketFile("now")]);
    const ticketId = (await call("GET", `/specs/${specId}`)).body.tickets[0]
      .id as number;
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = $1", [
      ticketId,
    ]);
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, started_at)
       VALUES ($1, (SELECT id FROM repos WHERE project_id = $2), $3, 'implement', $4)`,
      [
        specId,
        shop,
        ticketId,
        new Date(clock.now().getTime() - 10 * 60 * 1000),
      ],
    );

    expect(
      (await call("GET", "/workbench")).body.running[0].tickets[0],
    ).toMatchObject({ meanMs: null, slow: false });
  });

  it("lists awaiting-review and partially-merged specs with PR count and criterion ratio", async () => {
    const projectId = await projectAndRepo();
    const specId = await confirmedSpec(projectId, "review", "Ready", [
      ticketFile("a"),
    ]);
    await db.pool.query(
      "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
      [specId],
    );
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha)
       VALUES ($1, 1, 4, 'https://git.example/pr/4', 'open', 'abc')`,
      [specId],
    );
    await db.pool.query(
      `INSERT INTO acceptance_packs (spec_id, content) VALUES ($1, $2::jsonb)`,
      [
        specId,
        JSON.stringify({
          generatedAt: clock.now().toISOString(),
          mergeOrder: { ordered: ["backend"], after: {}, unordered: [] },
          orderBroken: [],
          repos: [
            {
              repo: "backend",
              pullRequest: null,
              gate: null,
              tickets: [
                {
                  displayId: "T-1",
                  title: "Ticket a",
                  appended: false,
                  criteria: [
                    {
                      text: "it works",
                      tests: ["t1"],
                      status: "verified",
                      reason: null,
                    },
                    {
                      text: "it is fast",
                      tests: [],
                      status: "unverified",
                      reason: "no tests",
                    },
                  ],
                  findings: [],
                  uncertainties: [],
                  protectedPathApprovals: [],
                },
              ],
              findings: [],
              scopeCreep: [],
              uncertainties: [],
              protectedPathApprovals: [],
            },
          ],
          cancelledTickets: [],
          agentSeconds: 0,
        }),
      ],
    );

    const reply = await call("GET", "/workbench");
    expect(reply.body.awaitingAcceptance).toEqual([
      {
        spec: expect.objectContaining({
          id: specId,
          title: "Ready",
          state: "awaiting-review",
        }),
        pullRequestCount: 1,
        verifiedCriteria: 1,
        totalCriteria: 2,
      },
    ]);
  });

  it("lists recently merged specs by when their pull requests last synced, not by id", async () => {
    const projectId = await projectAndRepo();
    const first = await confirmedSpec(projectId, "first", "First", [
      ticketFile("a"),
    ]);
    const second = await confirmedSpec(projectId, "second", "Second", [
      ticketFile("b"),
    ]);
    await db.pool.query("UPDATE specs SET state = 'merged'");
    const older = new Date(clock.now().getTime() - 3 * 86400 * 1000);
    const newer = new Date(clock.now().getTime() - 3600 * 1000);
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha, synced_at)
       VALUES ($1, 1, 1, 'https://git.example/pr/1', 'merged', 'aaa', $3),
              ($2, 1, 2, 'https://git.example/pr/2', 'merged', 'bbb', $4)`,
      [first, second, older, newer],
    );

    const completed = (await call("GET", "/workbench")).body.recentlyCompleted;
    expect(
      completed.map((row: { spec: { id: number } }) => row.spec.id),
    ).toEqual([second, first]);
    expect(completed[0].completedAt).toBe(newer.toISOString());
    expect(completed[1].completedAt).toBe(older.toISOString());
  });
});
