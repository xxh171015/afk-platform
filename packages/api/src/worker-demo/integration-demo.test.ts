import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions, AgentRunResult } from "@afk/pipeline";
import {
  composePrompt,
  git,
  gitOut,
  PROMPTS,
  type SandboxPlacement,
} from "@afk/pipeline";
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
import type { z } from "zod";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeClock,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

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
// What each agent run was given, and how many integration environments were up while it ran.
let agentRuns: {
  stage: string;
  prompt: string;
  placement: SandboxPlacement | undefined;
  environmentsUp: number;
}[];
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
  api = await listen(testApp({ pool: db.pool, clock: new FakeClock().now }));
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
  agentRuns = [];
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
    (
      await post(
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, { tickets }),
      )
    ).status,
  ).toBe(200);
  expect((await post(`/specs/${spec.body.id}/confirm`)).status).toBe(200);
}

// A fake agent that writes down what it was asked to run with, and whether an environment was up at the time.
class RecordingAgentRunner extends FakeAgentRunner {
  override async run<Schema extends z.ZodType>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentRunResult<z.infer<Schema>>> {
    agentRuns.push({
      stage: options.stage,
      prompt: readFileSync(options.promptFile, "utf8"),
      placement: options.placement,
      environmentsUp: docker.active,
    });
    return super.run(options);
  }
}

const DONE = {
  status: "done",
  summary: "x",
  acceptance: {},
  uncertainties: [],
};
const DIAGNOSIS = {
  result: "fail",
  failingRepo: "backend",
  evidence: "GET /orders/export answers 404",
  failingTests: ["exports"],
};
const PASS = {
  verdict: "pass",
  mustFix: [],
  suggestions: [],
  uncertainties: [],
  sources: ["AGENTS.md"],
};

function executor(): Omit<ExecutorDeps, "api"> {
  const repos = new RepoStore(join(home, "repos"));
  return {
    slots: new SlotManager({
      root: join(home, "slots"),
      count: 4,
      mainCloneFor: (repo, url) => repos.dirFor(repo, url),
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    }),
    repos,
    snapshots: new SnapshotStore(join(home, "snapshots")),
    push: (request) => pushRef(request),
    docker: docker.cli,
    environments,
    makeAgentRunner: (slotDir) =>
      new RecordingAgentRunner(slotDir, async (ctx) =>
        ctx.stage === "review"
          ? { output: PASS }
          : ctx.stage === "diagnose"
            ? { output: DIAGNOSIS } // only looks: no files
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

    // what docker was asked, in order: for the agent's run and for the e2e, leftovers first, then up, the seed, and
    // the whole thing down again
    const words = docker.calls
      .filter((c) => c[0] === "compose")
      .map(
        (c) =>
          `${c[2]}:${c.includes("down") ? "down" : c.includes("up") ? "up" : c[c.indexOf("run")]}`,
      );
    // the runs that had an environment: the integration ticket's implement (ticket 2) and its e2e
    const runOf = async (stage: string) =>
      (
        await db.pool.query(
          "SELECT id FROM runs WHERE stage = $1 AND ticket_id = 2",
          [stage],
        )
      ).rows[0].id;
    // the orphans of other workers go first, then what an earlier attempt of this run left, then the environment
    const lifecycle = (project: string) => [
      "afk-r-77:down",
      `${project}:down`,
      `${project}:up`,
      `${project}:run`,
      `${project}:down`,
    ];
    expect(words).toEqual([
      ...lifecycle(`afk-r-${await runOf("implement")}`),
      ...lifecycle(`afk-r-${await runOf("e2e")}`),
    ]);
  });

  it("runs the agent of an integration ticket in its environment, with the prompt for writing e2e", async () => {
    await confirmedSpec(["e2e"]);
    await work();

    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    // the backend ticket's agent is as it was; the integration ticket's is on the environment's network, with the
    // services' addresses, and the environment is up while it runs
    const [backend, integration] = agentRuns.filter(
      (r) => r.stage === "implement",
    );
    expect(backend).toMatchObject({
      prompt: composePrompt(PROMPTS.implement),
      placement: undefined,
      environmentsUp: 0,
    });
    expect(integration).toMatchObject({
      prompt: composePrompt(PROMPTS.integrationImplement),
      placement: {
        network: expect.stringMatching(/^afk-r-\d+_default$/),
        env: { BACKEND_URL: "http://backend:8080" },
      },
      environmentsUp: 1,
    });
    // the environment is gone again, and the ticket went on through the gate, review and merge to its e2e
    expect(docker.active).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT stage FROM runs WHERE ticket_id = 2 ORDER BY id",
        )
      ).rows.map((r) => r.stage),
    ).toEqual(["implement", "gate", "review", "review", "merge", "e2e"]); // a review is a Run per axis
  });

  it("diagnoses a failed e2e, makes a fix ticket in the repo it names, and gives up after two rounds", async () => {
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

    // T-1 backend, T-2 the integration ticket, T-3 and T-4 the fix tickets of the two rounds (both in the backend)
    expect(await stateOf()).toEqual([
      "1:done",
      "2:blocked/integration-loop-exceeded",
      "3:done",
      "4:done",
    ]);
    const runs = await e2eRuns();
    expect(runs.map((r) => r.result)).toEqual(["failed", "failed", "failed"]);
    expect(runs[0]).toMatchObject({ tests_total: 2, tests_failed: 1 });
    expect(runs[0].output.failingTests).toEqual(["exports"]);
    const fixes = await db.pool.query(
      "SELECT id, type, fix_for_ticket_id, fix_round, (SELECT name FROM repos WHERE id = repo_id) AS repo FROM tickets WHERE type = 'fix' ORDER BY id",
    );
    expect(fixes.rows).toEqual([
      {
        id: 3,
        type: "fix",
        fix_for_ticket_id: 2,
        fix_round: 1,
        repo: "backend",
      },
      {
        id: 4,
        type: "fix",
        fix_for_ticket_id: 2,
        fix_round: 2,
        repo: "backend",
      },
    ]);
    // the diagnosis ran in an environment, with the diagnosis prompt, and left nothing behind
    const diagnoses = agentRuns.filter((r) => r.stage === "diagnose");
    expect(diagnoses).toHaveLength(2);
    for (const run of diagnoses)
      expect(run).toMatchObject({
        prompt: composePrompt(PROMPTS.diagnose),
        placement: { env: { BACKEND_URL: "http://backend:8080" } },
        environmentsUp: 1,
      });
    expect(docker.active).toBe(0);
  });

  it("is blocked as integration-environment-failed after three environments that did not come up", async () => {
    // the environment the agent works in comes up; the ones for the e2e do not
    let ups = 0;
    docker.answer = (args) =>
      args.includes("up") && ++ups > 1
        ? { code: 1, out: "backend is unhealthy" }
        : undefined;
    await confirmedSpec(["e2e"]);
    await work();

    expect(await stateOf()).toEqual([
      "1:done",
      "2:blocked/integration-environment-failed",
    ]);
    expect(docker.calls.filter((c) => c.includes("up"))).toHaveLength(4);
    // every try took its environment down again
    expect(
      docker.calls.filter((c) => c.includes("down")).length,
    ).toBeGreaterThanOrEqual(4);
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
