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
import type { Bundle } from "./bundle.ts";

// The last stage of an integration ticket: after its merge the worker runs the e2e in a fresh integration
// environment, and only a passing e2e makes the ticket done (docs/specs/m2-platform.md「联调」).

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
async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const integrationTicket = {
  key: "e2e",
  repo: "frontend",
  type: "integration",
  title: "Order export e2e",
  modules: ["e2e/**"],
  acceptance: ["the export button downloads a file"],
  environment: ["backend"],
};

async function runningSpec(project: Record<string, unknown> = {}) {
  const created = await post("/projects", { name: "shop", ...project });
  for (const name of ["backend", "frontend"]) {
    await post(`/projects/${created.body.id}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  }
  const spec = await post("/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  const imported = await post(
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, {
      tickets: [integrationTicket],
    }),
  );
  expect(imported.status).toBe(200);
  await post(`/specs/${spec.body.id}/confirm`);
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: { stage: string; ticketId: number };
}
const claim = async () => (await worker.claim()).body.job as Claimed | null;

async function stage(expected: string, result: Record<string, unknown>) {
  const job = await claim();
  expect(job?.payload.stage).toBe(expected);
  const reply = await worker.complete(
    (job as Claimed).id,
    (job as Claimed).attempt,
    { stage: expected, ...result },
  );
  expect(reply.status).toBe(200);
  return job as Claimed;
}

const ticketRow = async () =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason FROM tickets WHERE id = 1",
    )
  ).rows[0];

// Takes the ticket up to its merge.
async function mergeIntegrationTicket() {
  await stage("implement", { outcome: "done" });
  await stage("gate", { outcome: "passed" });
  await stage("review", { outcome: "pass" });
  await stage("merge", { outcome: "merged", headSha: "fe-head" });
}

describe("the e2e stage", () => {
  it("follows the merge of an integration ticket, which stays merging until it passes", async () => {
    await runningSpec();
    await mergeIntegrationTicket();
    expect((await ticketRow()).state).toBe("merging");
    const e2e = await stage("e2e", { outcome: "passed" });
    expect(e2e.type).toBe("e2e");
    expect((await ticketRow()).state).toBe("done");
  });

  it("is followed by a diagnosis when the e2e fails (see diagnosis-api.test.ts)", async () => {
    await runningSpec();
    await mergeIntegrationTicket();
    await stage("e2e", { outcome: "failed" });
    expect((await claim())?.payload.stage).toBe("diagnose");
    expect((await ticketRow()).state).toBe("merging");
  });

  it("is not queued for a ticket that is not an integration ticket", async () => {
    const created = await post("/projects", { name: "solo" });
    await post(`/projects/${created.body.id}/repos`, {
      url: "git@x:backend",
      name: "backend",
    });
    const spec = await post("/specs", {
      projectId: created.body.id,
      type: "feature",
      slug: "plain",
      title: "Plain",
    });
    await post(
      `/specs/${spec.body.id}/tickets/import`,
      importBody(spec.body.id, {
        tickets: [
          {
            key: "a",
            repo: "backend",
            type: "implementation",
            title: "A",
            modules: ["src/a/**"],
            acceptance: ["it works"],
          },
        ],
      }),
    );
    await post(`/specs/${spec.body.id}/confirm`);
    for (const name of ["implement", "gate", "review"])
      await stage(name, {
        outcome:
          name === "implement" ? "done" : name === "gate" ? "passed" : "pass",
      });
    await stage("merge", { outcome: "merged" });
    expect((await ticketRow()).state).toBe("done");
    // what follows the last ticket is the overall review, not an e2e
    expect((await claim())?.payload.stage).toBe("final-review");
  });

  it("keeps its gate result apart from the gate result of the same commit", async () => {
    await runningSpec();
    await stage("implement", { outcome: "done" });
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", {
      outcome: "merged",
      headSha: "fe-head",
      gate: {
        commitSha: "fe-head",
        configSha: "cfg",
        testsTotal: 8,
        testsSkipped: 0,
      },
    });
    await stage("e2e", {
      outcome: "passed",
      run: {
        headSha: "fe-head",
        refShas: { backend: "be-head" },
        testsTotal: 3,
        testsFailed: 0,
        envUpMs: 4200,
      },
      gate: {
        commitSha: "fe-head",
        configSha: "cfg",
        testsTotal: 3,
        testsSkipped: 0,
        kind: "e2e",
        testCases: [{ name: "exports", classname: "e2e", status: "passed" }],
      },
    });
    const gates = (
      await db.pool.query(
        "SELECT kind, tests_total FROM gate_results ORDER BY kind",
      )
    ).rows;
    expect(gates).toEqual([
      { kind: "e2e", tests_total: 3 },
      { kind: "gate", tests_total: 8 },
    ]);
    const run = (
      await db.pool.query(
        "SELECT ref_shas, head_sha, tests_total, tests_failed, env_up_ms FROM runs WHERE stage = 'e2e'",
      )
    ).rows[0];
    expect(run).toEqual({
      ref_shas: { backend: "be-head" },
      head_sha: "fe-head",
      tests_total: 3,
      tests_failed: 0,
      env_up_ms: 4200,
    });
  });

  it("gives the baseline of the next gate from the unit gate, not from the e2e", async () => {
    await runningSpec();
    await stage("implement", { outcome: "done" });
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", {
      outcome: "merged",
      headSha: "fe-head",
      run: { headSha: "fe-head" },
      gate: { commitSha: "fe-head", configSha: "c", testsTotal: 8 },
    });
    await stage("e2e", {
      outcome: "passed",
      run: { headSha: "fe-head" },
      gate: {
        commitSha: "fe-head",
        configSha: "c",
        testsTotal: 3,
        kind: "e2e",
      },
    });
    const baseline = await db.pool.query(
      `SELECT g.tests_total FROM runs r
       JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
       WHERE r.stage = 'merge'`,
    );
    expect(baseline.rows).toEqual([{ tests_total: 8 }]);
  });
});

async function bundleOfNextJob(): Promise<Bundle | null> {
  const job = await claim();
  if (!job) return null;
  const response = await fetch(
    `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
  );
  return (await response.json()) as Bundle;
}

describe("the e2e job", () => {
  it("is not agent time, and a failing environment ends in integration-environment-failed", async () => {
    await runningSpec();
    await mergeIntegrationTicket();
    for (let failures = 1; failures <= 3; failures++) {
      const job = await claim();
      expect(job?.payload.stage).toBe("e2e");
      await worker.fail(
        (job as Claimed).id,
        (job as Claimed).attempt,
        "build failed",
      );
    }
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "integration-environment-failed",
    });
    expect(await claim()).toBeNull();
  });

  it("ends the implement of an integration ticket in integration-environment-failed too: its agent works in the environment", async () => {
    await runningSpec();
    for (let failures = 1; failures <= 3; failures++) {
      const job = await claim();
      expect(job?.payload.stage).toBe("implement");
      await worker.fail(
        (job as Claimed).id,
        (job as Claimed).attempt,
        "compose up failed",
      );
    }
    expect(await ticketRow()).toMatchObject({
      state: "blocked",
      blocked_reason: "integration-environment-failed",
    });
  });

  it("carries the environment repos and the environment limit in its bundle", async () => {
    await runningSpec({ limits: { maxIntegrationEnvironments: 2 } });
    await mergeIntegrationTicket();
    const bundle = (await bundleOfNextJob()) as Bundle;
    expect(bundle.job.stage).toBe("e2e");
    expect(bundle.environment).toEqual([
      {
        name: "backend",
        url: "git@x:backend",
        defaultBranch: "main",
        sha: null,
      },
    ]);
    expect(bundle.limits.maxIntegrationEnvironments).toBe(2);
  });
});
