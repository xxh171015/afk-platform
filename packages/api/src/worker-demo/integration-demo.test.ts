import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateCache, git, gitOut } from "@afk/pipeline";
import {
  FakeAgentRunner,
  FakeDocker,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import {
  createWorkerApi,
  EnvironmentLimiter,
  type ExecutorDeps,
  pushRef,
  RepoStore,
  runWorker,
  SlotManager,
  SnapshotStore,
} from "@afk/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeClock, listen, type RunningApi } from "../test/fake-worker.ts";

// An integration ticket from import to done, with a real Postgres, the HTTP API, real git, slots and snapshots,
// and a worker with a fake agent, a fake gate sandbox and a fake docker: the e2e stage after the merge
// (docs/specs/m2-platform.md「联调」).

const ID = "abc123";

let db: TestDatabase;
let api: RunningApi;
let home: string;
let backendSeed: TestRepo;
let frontendSeed: TestRepo;
let docker: FakeDocker;
let environments: EnvironmentLimiter;
const origins: Record<string, string> = {};

const COUNT_TESTS =
  'mkdir -p reports && printf \'<testsuites tests="3"><testsuite name="a" tests="3" skipped="0"/></testsuites>\' > reports/junit.xml';
const GATES = [
  "commands:",
  "  - name: test",
  `    run: ${JSON.stringify(COUNT_TESTS)}`,
  "    timeoutSeconds: 30",
  "    junit: reports/junit.xml",
  "",
].join("\n");

// What the frontend's `npm run e2e` does here: needs the backend's address, fails when E2E_FAIL is in the repo.
const E2E_SH = `
mkdir -p reports
fail="" ; [ -f E2E_FAIL ] && fail="<failure>boom</failure>"
[ -n "$BACKEND_URL" ] || fail="<failure>no BACKEND_URL</failure>"
printf '<testsuites tests="2"><testsuite name="e2e" tests="2" skipped="0"><testcase name="lists orders" classname="e2e"/><testcase name="exports" classname="e2e">%s</testcase></testsuite></testsuites>' "$fail" > reports/e2e-junit.xml
`;

const FRAGMENT = `
x-afk-env:
  BACKEND_URL: http://backend:8080
services:
  backend:
    image: backend:fake
  seed-backend:
    image: seed:fake
`;

const bareOf = (name: string, seed: TestRepo) => {
  const dir = join(home, `${name}.git`);
  git(home, ["clone", "--quiet", "--bare", seed.dir, dir]);
  origins[name] = dir;
};

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  await db.pool.query("UPDATE instance SET id = $1", [ID]);
  api = await listen(createApp({ pool: db.pool, clock: new FakeClock().now }));
  home = mkdtempSync(join(tmpdir(), "afk-int-home-"));
  backendSeed = makeRepo({
    ".sandcastle/gates.yaml": GATES,
    ".sandcastle/integration/compose.yaml": FRAGMENT,
  });
  frontendSeed = makeRepo({
    ".sandcastle/gates.yaml": GATES,
    "package.json": JSON.stringify({ scripts: { e2e: "sh e2e.sh" } }),
    "e2e.sh": E2E_SH,
  });
  bareOf("backend", backendSeed);
  bareOf("frontend", frontendSeed);
  docker = new FakeDocker();
  environments = new EnvironmentLimiter();
});
afterEach(async () => {
  await api.close();
  await db.drop();
  backendSeed.cleanup();
  frontendSeed.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { id: number },
  };
}

async function confirmedSpec(
  integrationKeys: string[],
  project: Record<string, unknown> = {},
) {
  const created = await post("/projects", { name: "shop", ...project });
  for (const name of ["backend", "frontend"])
    await post(`/projects/${created.body.id}/repos`, {
      url: origins[name],
      name,
    });
  const spec = await post("/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  const tickets = [
    {
      key: "be",
      repo: "backend",
      type: "implementation",
      title: "Backend export",
      modules: ["src/be/**"],
      acceptance: ["it works"],
    },
    ...integrationKeys.map((key) => ({
      key,
      repo: "frontend",
      type: "integration",
      title: `Export e2e ${key}`,
      modules: [`e2e/${key}/**`],
      acceptance: ["the export button downloads a file"],
      environment: ["backend"],
      blocked_by: ["be"],
    })),
  ];
  expect(
    (await post(`/specs/${spec.body.id}/tickets/import`, { tickets })).status,
  ).toBe(200);
  expect((await post(`/specs/${spec.body.id}/confirm`)).status).toBe(200);
}

const DONE = {
  status: "done",
  summary: "x",
  acceptance: {},
  uncertainties: [],
};
const PASS = {
  verdict: "pass",
  mustFix: [],
  suggestions: [],
  uncertainties: [],
};

function executor(): Omit<ExecutorDeps, "api"> {
  const repos = new RepoStore(join(home, "repos"));
  return {
    slots: new SlotManager({
      root: join(home, "slots"),
      count: 4,
      mainCloneFor: (repo) => repos.dirFor(repo),
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    }),
    repos,
    snapshots: new SnapshotStore(join(home, "snapshots")),
    push: (request) => pushRef(request),
    gateCache: new GateCache(),
    docker: docker.cli,
    environments,
    makeAgentRunner: (slotDir) =>
      new FakeAgentRunner(slotDir, async (ctx) =>
        ctx.stage === "review"
          ? { output: PASS }
          : {
              files: {
                [`src/agent-${ctx.branch.split("/").at(-1)}.ts`]: `export const x = 1;\n`,
              },
              message: `${ctx.stage} on ${ctx.branch}`,
              output: DONE,
            },
      ),
    makeGateSandbox: (slotDir) => new FakeGateSandbox(slotDir),
  };
}

const work = (concurrency = 1) =>
  runWorker({
    api: createWorkerApi(api.url, "w1"),
    executor: executor(),
    stopWhenIdle: true,
    heartbeatMs: 50,
    concurrency,
  });

// Several loops of one worker at once (stopWhenIdle would end the idle ones at the start): runs until every ticket
// is done or blocked.
async function workConcurrently(concurrency: number) {
  const stop = new AbortController();
  const worker = runWorker({
    api: createWorkerApi(api.url, "w1"),
    executor: executor(),
    heartbeatMs: 50,
    pollMs: 20,
    concurrency,
    signal: stop.signal,
  });
  for (let i = 0; i < 600; i++) {
    const open = await db.pool.query(
      "SELECT 1 FROM tickets WHERE state NOT IN ('done', 'blocked')",
    );
    if (open.rows.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stop.abort();
  await worker;
}

const stateOf = async () =>
  (
    await db.pool.query(
      "SELECT id, state, blocked_reason FROM tickets ORDER BY id",
    )
  ).rows.map(
    (r) =>
      `${r.id}:${r.state}${r.blocked_reason ? `/${r.blocked_reason}` : ""}`,
  );
const e2eRuns = async () =>
  (
    await db.pool.query(
      "SELECT result, head_sha, ref_shas, tests_total, tests_failed, env_up_ms, duration_ms, output FROM runs WHERE stage = 'e2e' ORDER BY id",
    )
  ).rows;

describe("the e2e stage of an integration ticket", { timeout: 60_000 }, () => {
  it("builds the environment from the snapshots, runs the e2e on its network and makes the ticket done", async () => {
    docker.orphans = ["afk-r-77"]; // left by a worker that was killed
    await confirmedSpec(["e2e"]);
    await work();

    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    const [run] = await e2eRuns();
    const backendHead = gitOut(origins.backend as string, [
      "rev-parse",
      `spec/${ID}/order-export`,
    ]);
    const frontendHead = gitOut(origins.frontend as string, [
      "rev-parse",
      `spec/${ID}/order-export`,
    ]);
    expect(run).toMatchObject({
      result: "passed",
      head_sha: frontendHead,
      ref_shas: { backend: backendHead },
      tests_total: 2,
      tests_failed: 0,
      duration_ms: null, // not agent time
    });
    expect(run.env_up_ms).toBeGreaterThanOrEqual(0);

    const gates = await db.pool.query(
      "SELECT kind, tests_total FROM gate_results WHERE repo_id = 2 AND commit_sha = $1 ORDER BY kind",
      [frontendHead],
    );
    expect(gates.rows).toEqual([
      { kind: "e2e", tests_total: 2 },
      { kind: "gate", tests_total: 3 },
    ]);

    // what docker was asked, in order: leftovers first, then up, the seed, and the whole thing down again
    const words = docker.calls
      .filter((c) => c[0] === "compose")
      .map(
        (c) =>
          `${c[2]}:${c.includes("down") ? "down" : c.includes("up") ? "up" : c[c.indexOf("run")]}`,
      );
    const runId = (
      await db.pool.query("SELECT id FROM runs WHERE stage = 'e2e'")
    ).rows[0].id;
    const project = `afk-r-${runId}`;
    expect(words).toEqual([
      "afk-r-77:down",
      `${project}:up`,
      `${project}:run`,
      `${project}:down`,
    ]);
  });

  it("blocks the ticket, with the failing tests in the run, when the e2e fails", async () => {
    writeFileSync(join(frontendSeed.dir, "E2E_FAIL"), "");
    git(frontendSeed.dir, ["add", "."]);
    git(frontendSeed.dir, ["commit", "-qm", "fail the e2e"]);
    git(home, [
      "-C",
      origins.frontend as string,
      "fetch",
      "-q",
      frontendSeed.dir,
      "main:main",
    ]);
    await confirmedSpec(["e2e"]);
    await work();

    expect(await stateOf()).toEqual([
      "1:done",
      "2:blocked/post-merge-gate-failed",
    ]);
    const [run] = await e2eRuns();
    expect(run).toMatchObject({
      result: "failed",
      tests_total: 2,
      tests_failed: 1,
    });
    expect(run.output.failingTests).toEqual(["exports"]);
    // the environment is gone in any case
    expect(docker.calls.filter((c) => c.includes("down"))).toHaveLength(1);
  });

  it("is blocked as integration-environment-failed after three environments that did not come up", async () => {
    docker.answer = (args) =>
      args.includes("up")
        ? { code: 1, out: "backend is unhealthy" }
        : undefined;
    await confirmedSpec(["e2e"]);
    await work();

    expect(await stateOf()).toEqual([
      "1:done",
      "2:blocked/integration-environment-failed",
    ]);
    expect(docker.calls.filter((c) => c.includes("up"))).toHaveLength(3);
    // every try took its environment down again
    expect(
      docker.calls.filter((c) => c.includes("down")).length,
    ).toBeGreaterThanOrEqual(3);
    const failed = await db.pool.query(
      "SELECT output FROM runs WHERE stage = 'e2e' AND result = 'job-failed'",
    );
    expect(failed.rows).toHaveLength(3);
    expect(failed.rows[0].output.error).toContain("backend is unhealthy");
  });

  it("starts the second environment of a worker only when the first is down", async () => {
    docker.upDelayMs = 1500;
    class Spy extends EnvironmentLimiter {
      waited = 0;
      override acquire(max: number, signal?: AbortSignal) {
        if (this.active >= max) this.waited += 1;
        return super.acquire(max, signal);
      }
    }
    const spy = new Spy();
    environments = spy;
    await confirmedSpec(["e2e1", "e2e2"]);
    await workConcurrently(2);

    expect(await stateOf()).toEqual(["1:done", "2:done", "3:done"]);
    expect(spy.waited).toBeGreaterThanOrEqual(1);
    expect(docker.maxActive).toBe(1);
  });

  it("starts two at once when the project allows two", async () => {
    docker.upDelayMs = 1500;
    await confirmedSpec(["e2e1", "e2e2"], {
      limits: { maxIntegrationEnvironments: 2 },
    });
    await workConcurrently(2);

    expect(await stateOf()).toEqual(["1:done", "2:done", "3:done"]);
    expect(docker.maxActive).toBe(2);
  });
});
