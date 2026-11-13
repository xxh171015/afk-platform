import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
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

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

async function runningSpec() {
  const created = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  expect(
    (
      await call(
        "POST",
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, { tickets: [ticket("a")] }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
    200,
  );
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}

async function stage(expected: string, result: Record<string, unknown>) {
  const job = (await worker.claim()).body.job as Claimed | null;
  expect(job?.payload.stage).toBe(expected);
  const reply = await worker.complete(
    (job as Claimed).id,
    (job as Claimed).attempt,
    {
      stage: expected,
      ...result,
    },
  );
  expect(reply.status).toBe(200);
  return job as Claimed;
}

const REWRITTEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REWRITTEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BEFORE_REWRITE = "cccccccccccccccccccccccccccccccccccccccc";

describe("ticket Links after a merge into the integration branch", () => {
  it("can be read over HTTP by commit SHA or spec, matching the rewritten commits the run recorded", async () => {
    const specId = await runningSpec();
    await stage("implement", {
      outcome: "done",
      run: { commits: [REWRITTEN_A, REWRITTEN_B] },
    });
    const runId = ((await call("GET", "/tickets/1")).body.runs as Json[]).find(
      (run) => run.stage === "implement",
    ).id as number;
    const recorded = await call("GET", `/runs/${runId}`);
    expect(recorded.body.commits).toEqual([REWRITTEN_A, REWRITTEN_B]);

    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "integration-head" });

    const bySha = await call("GET", `/links?sha=${REWRITTEN_A}`);
    expect(bySha.status).toBe(200);
    expect(bySha.body.links).toEqual([
      expect.objectContaining({
        kind: "ticket",
        repo: "backend",
        sha: REWRITTEN_A,
        specId,
        specDisplayId: `S-${specId}`,
        ticketId: 1,
        ticketDisplayId: "T-1",
        runId,
        runDisplayId: `R-${runId}`,
      }),
    ]);

    const bySpec = await call("GET", `/specs/${specId}/links`);
    expect(bySpec.status).toBe(200);
    expect(bySpec.body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ticket", sha: REWRITTEN_A, runId }),
        expect.objectContaining({ kind: "ticket", sha: REWRITTEN_B, runId }),
      ]),
    );
    expect(bySpec.body.links).toHaveLength(2);
  });
});

const REVIEW_FIX = {
  outcome: "fix",
  run: {
    output: {
      verdict: "fix",
      mustFix: [{ file: "src/a.ts", line: 3, problem: "rename" }],
      suggestions: [],
    },
  },
  findings: [{ kind: "must-fix", body: "src/a.ts:3 rename" }],
};

describe("Links for a wrap-up fix merged into the integration branch", () => {
  it("have Spec and Run, and Ticket is empty", async () => {
    const specId = await runningSpec();
    await stage("implement", { outcome: "done" });
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "ticket-head" });

    await stage("final-review", REVIEW_FIX);
    await stage("final-fix", {
      outcome: "done",
      run: { commits: [REWRITTEN_A] },
    });
    const runId = (
      (await call("GET", `/specs/${specId}`)).body.finalRuns as Json[]
    ).find((run) => run.stage === "final-fix").id as number;
    await stage("final-merge", { outcome: "merged", headSha: "settled" });

    const bySha = await call("GET", `/links?sha=${REWRITTEN_A}`);
    expect(bySha.status).toBe(200);
    expect(bySha.body.links).toEqual([
      expect.objectContaining({
        kind: "ticket",
        repo: "backend",
        sha: REWRITTEN_A,
        specId,
        specDisplayId: `S-${specId}`,
        ticketId: null,
        ticketDisplayId: null,
        runId,
        runDisplayId: `R-${runId}`,
      }),
    ]);
  });
});

describe("Sandcastle SHAs from before trailer rewrite", () => {
  it("are not stored as Links after the ticket merges", async () => {
    const specId = await runningSpec();
    await stage("implement", {
      outcome: "agent-gave-up",
      run: { commits: [BEFORE_REWRITE] },
    });
    expect(
      (await call("POST", "/tickets/1/retry", { mode: "continue" })).status,
    ).toBe(200);
    await stage("implement", {
      outcome: "done",
      run: { commits: [REWRITTEN_A] },
    });
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "integration-head" });

    const original = await call("GET", `/links?sha=${BEFORE_REWRITE}`);
    expect(original.status).toBe(200);
    expect(original.body.links).toEqual([]);

    const rewritten = await call("GET", `/links?sha=${REWRITTEN_A}`);
    expect(rewritten.body.links).toEqual([
      expect.objectContaining({
        kind: "ticket",
        sha: REWRITTEN_A,
        specId,
        ticketId: 1,
      }),
    ]);
  });
});
