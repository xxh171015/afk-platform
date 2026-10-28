import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateCache, git, gitOut } from "@afk/pipeline";
import {
  type FakeAgentContext,
  FakeAgentRunner,
  type FakeAgentStep,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import {
  createWorkerApi,
  type ExecutorDeps,
  processJob,
  pushRef,
  RepoStore,
  runWorker,
  SlotManager,
} from "@afk/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeClock, listen, type RunningApi } from "../test/fake-worker.ts";

// A whole spec from import to done, with a real Postgres, the HTTP API, real git and slots, and a worker that has
// a fake agent and a fake gate sandbox: no Cursor, no GitHub, no Docker.

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;
let logDir: string;
let home: string;
let origin: string; // bare repo standing in for GitHub
let seed: TestRepo;

const JUNIT =
  '<testsuites tests="3"><testsuite name="a" tests="3" skipped="0"/></testsuites>';
const GATES = [
  "commands:",
  "  - name: test",
  `    run: "test ! -f BROKEN && mkdir -p reports && echo ${Buffer.from(JUNIT).toString("base64")} | base64 -d > reports/junit.xml"`,
  "    timeoutSeconds: 30",
  "    junit: reports/junit.xml",
  "",
].join("\n");

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  logDir = mkdtempSync(join(tmpdir(), "afk-demo-logs-"));
  home = mkdtempSync(join(tmpdir(), "afk-demo-home-"));
  api = await listen(createApp({ pool: db.pool, clock: clock.now, logDir }));
  seed = makeRepo({ ".sandcastle/gates.yaml": GATES, "README.md": "# shop\n" });
  origin = join(home, "origin.git");
  git(home, ["clone", "--quiet", "--bare", seed.dir, origin]);
});
afterEach(async () => {
  await api.close();
  await db.drop();
  seed.cleanup();
  rmSync(logDir, { recursive: true, force: true });
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

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

async function confirmedSpec(
  tickets: Record<string, unknown>[],
  project: Record<string, unknown> = {},
) {
  const created = await post("/projects", {
    name: "shop",
    protectedPaths: [".github/"],
    ...project,
  });
  await post(`/projects/${created.body.id}/repos`, {
    url: origin,
    role: "backend",
  });
  const spec = await post("/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  expect(
    (await post(`/specs/${spec.body.id}/tickets/import`, { tickets })).status,
  ).toBe(200);
  expect((await post(`/specs/${spec.body.id}/confirm`)).status).toBe(200);
  return spec.body.id;
}

const DONE = {
  status: "done",
  summary: "did it",
  acceptance: {},
  uncertainties: [],
};
const PASS = {
  verdict: "pass",
  mustFix: [],
  suggestions: ["rename x"],
  uncertainties: [],
};

// The fake agent: every ticket adds a file named after its branch; the script can be overridden per stage.
type Script = (
  ctx: FakeAgentContext,
) => FakeAgentStep | undefined | Promise<FakeAgentStep | undefined>;
function deps(over: { script?: Script; concurrency?: number } = {}) {
  const base: Omit<ExecutorDeps, "api"> = {
    slots: new SlotManager({
      root: join(home, "slots"),
      count: 3,
      mainCloneFor: (repo) => repos.dirFor(repo),
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    }),
    repos: undefined as never,
    push: (request) => pushRef(request),
    gateCache: new GateCache(),
    makeAgentRunner: (slotDir) =>
      new FakeAgentRunner(slotDir, async (ctx) => {
        const custom = await over.script?.(ctx);
        if (custom) return custom;
        if (ctx.stage === "review") return { output: PASS };
        return {
          files: {
            [`src/${ctx.branch.replace("/", "-")}.ts`]: `export const ${ctx.stage.replace("-", "")} = 1;\n`,
          },
          message: `${ctx.stage} on ${ctx.branch}`,
          output: DONE,
        };
      }),
    makeGateSandbox: (slotDir) => new FakeGateSandbox(slotDir),
    idleSeconds: 600,
    wallClockMs: 60_000,
  };
  const repos = new RepoStore(join(home, "repos"));
  base.repos = repos;
  return base;
}

const workerFor = (id = "w1") => createWorkerApi(api.url, id);
const stateOf = async () =>
  (
    await db.pool.query(
      "SELECT id, state, blocked_reason FROM tickets ORDER BY id",
    )
  ).rows.map(
    (r) =>
      `${r.id}:${r.state}${r.blocked_reason ? `/${r.blocked_reason}` : ""}`,
  );

describe("a whole spec with a fake agent", () => {
  it("takes two tickets, one depending on the other, from confirmation to done", async () => {
    await confirmedSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const executor = deps();
    const run = await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });

    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    // implement, gate, review, merge: four jobs per ticket
    expect(run.jobs).toBe(8);

    // the integration branch on "GitHub" has both tickets' work, and main was never touched
    expect(
      gitOut(origin, ["show", "spec/order-export:src/agent-T-1.ts"]),
    ).toContain("implement");
    expect(
      gitOut(origin, ["show", "spec/order-export:src/agent-T-2.ts"]),
    ).toContain("implement");
    expect(gitOut(origin, ["rev-parse", "main"])).toBe(
      gitOut(seed.dir, ["rev-parse", "main"]),
    );
    // ticket 2 only started after ticket 1 was on the integration branch
    const order = gitOut(origin, [
      "log",
      "--format=%s",
      "--first-parent",
      "--reverse",
      "main..spec/order-export",
    ]).split("\n");
    expect(order).toEqual([
      "Merge agent/T-1 into spec/order-export",
      "Merge agent/T-2 into spec/order-export",
    ]);
    // the ticket branches were pushed, with the traceability trailers on the agent's commits
    for (const [id, run] of [
      ["T-1", "R-1"],
      ["T-2", "R-5"],
    ]) {
      const body = gitOut(origin, ["log", "-1", "--format=%B", `agent/${id}`]);
      expect(body).toContain("Spec: S-1");
      expect(body).toContain(`Ticket: ${id}`);
      expect(body).toContain(`Run: ${run}`);
    }
  });

  it("records a Run with a log for every stage, and the gate results", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker({
      api: workerFor(),
      executor: deps(),
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    const runs = await db.pool.query(
      "SELECT id, stage, result, finished_at FROM runs ORDER BY id",
    );
    expect(runs.rows.map((r) => [r.stage, r.result])).toEqual([
      ["implement", "done"],
      ["gate", "passed"],
      ["review", "pass"],
      ["merge", "merged"],
    ]);
    expect(runs.rows.every((r) => r.finished_at !== null)).toBe(true);
    const gates = await db.pool.query(
      "SELECT tests_total, tests_skipped FROM gate_results",
    );
    expect(gates.rows[0]).toEqual({ tests_total: 3, tests_skipped: 0 });

    const logs = await fetch(`${api.url}/runs/${runs.rows[0].id}/logs`).then(
      (r) => r.json(),
    );
    expect(logs.text).toContain("implement: running the agent on agent/T-1");
    expect(logs.text).toContain("result: implement done");
    const findings = await db.pool.query(
      "SELECT kind, resolution FROM findings",
    );
    expect(findings.rows).toEqual([
      { kind: "suggestion", resolution: "acceptance-pack" },
    ]);
  });

  it("frees every slot afterwards: no clone is left behind after a clean run", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps();
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    const slots = join(home, "slots");
    const fs = await import("node:fs");
    for (const index of fs.readdirSync(slots)) {
      const entries = fs.readdirSync(join(slots, index));
      expect(entries).not.toContain("backend");
      expect(entries).not.toContain("lock");
    }
  });

  it("fixes a failing gate once and goes on to done", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps({
      script: (ctx) => {
        if (ctx.stage === "implement")
          return { files: { BROKEN: "x\n", "src/a.ts": "a\n" }, output: DONE };
        if (ctx.stage === "gate-fix") {
          // the fix reads what the gate said
          expect(ctx.context("failure/gate.log")).toContain("test failed");
          return { remove: ["BROKEN"], output: DONE };
        }
        return undefined;
      },
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:done"]);
    const stages = await db.pool.query(
      "SELECT stage, result FROM runs ORDER BY id",
    );
    expect(stages.rows.map((r) => `${r.stage}:${r.result}`)).toEqual([
      "implement:done",
      "gate:failed",
      "gate-fix:done",
      "gate:passed",
      "review:pass",
      "merge:merged",
    ]);
  });

  it("blocks a ticket whose agent gives up, and starts nothing behind it", async () => {
    await confirmedSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const executor = deps({
      script: (ctx) =>
        ctx.stage === "implement"
          ? {
              output: {
                status: "cannot-proceed",
                blockedReason: "agent-gave-up",
                detail: "needs a decision",
              },
            }
          : undefined,
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:blocked/agent-gave-up", "2:pending"]);
  });

  it("blocks a ticket that touches an unapproved protected path, before any gate runs", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps({
      script: (ctx) =>
        ctx.stage === "implement"
          ? {
              files: { ".github/workflows/ci.yml": "on: push\n" },
              output: DONE,
            }
          : undefined,
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:blocked/protected-path-changed"]);
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM gate_results")).rows[0]
          .count,
      ),
    ).toBe(0);
  });

  it("sends a merge conflict to merge-fix and finishes", async () => {
    // both tickets rewrite the same file; the second one conflicts when it is merged
    await confirmedSpec([ticket("a"), ticket("b")], {
      limits: { projectConcurrency: 2, repoConcurrency: 2 },
    });
    const executor = deps({
      script: (ctx) => {
        if (ctx.stage === "implement") {
          return { files: { "shared.txt": `${ctx.branch}\n` }, output: DONE };
        }
        if (ctx.stage === "merge-fix") {
          // the agent merges the integration branch and settles the conflict
          git(ctx.dir, [
            "fetch",
            "--quiet",
            ".",
            "refs/heads/spec/order-export:refs/heads/spec/order-export",
          ]);
          git(ctx.dir, ["merge", "--no-edit", "spec/order-export"]);
          return { files: { "shared.txt": "settled\n" }, output: DONE };
        }
        return undefined;
      },
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    expect(gitOut(origin, ["show", "spec/order-export:shared.txt"])).toBe(
      "settled",
    );
  });
});

describe("failures of the worker's own", () => {
  it("fails the job, keeps the slot's clone, and tells the API", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps({
      script: () => ({
        error: { kind: "other", message: "docker daemon not running" },
      }),
    });
    const api2 = workerFor();
    const job = await api2.claim([]);
    const outcome = await processJob(
      { api: api2, executor, heartbeatMs: 50 },
      job as NonNullable<typeof job>,
    );
    expect(outcome).toBe("failed");
    const stored = await db.pool.query("SELECT state, error FROM jobs");
    expect(stored.rows[0].state).toBe("failed");
    expect(stored.rows[0].error).toContain("docker daemon not running");
    // the failed task's clone stays for a look
    expect(
      (await import("node:fs")).readdirSync(join(home, "slots", "0")),
    ).toContain("backend");
  });
});

describe("losing the lease", () => {
  it("aborts the local run at once and reports nothing", async () => {
    await confirmedSpec([ticket("a")]);
    let sawAbort = false;
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor = deps({
      script: async (ctx) => {
        if (ctx.stage !== "implement") return undefined;
        started();
        await new Promise<void>((resolve) =>
          ctx.signal?.addEventListener("abort", () => resolve()),
        );
        sawAbort = true;
        return { output: DONE };
      },
    });
    const worker = workerFor("w1");
    const job = (await worker.claim([])) as NonNullable<
      Awaited<ReturnType<typeof worker.claim>>
    >;
    const running = processJob({ api: worker, executor, heartbeatMs: 30 }, job);
    await agentStarted;
    clock.advanceSeconds(121); // the lease runs out; the next heartbeat is refused
    expect(await running).toBe("abandoned");
    expect(sawAbort).toBe(true);
    // nothing was reported: the job is still the API's to hand out again, and the ticket did not move
    const stored = await db.pool.query("SELECT state FROM jobs WHERE id = $1", [
      job.id,
    ]);
    expect(stored.rows[0].state).toBe("running");
    expect(await stateOf()).toEqual(["1:running"]);
    // the slot was released, so the next try can use it
    const entries = (await import("node:fs")).readdirSync(
      join(home, "slots", "0"),
    );
    expect(entries).not.toContain("lock");
  });
});

describe("what the worker may and may not know", () => {
  it("has no database and no api package behind it", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(import.meta.dirname, "../../../worker");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    expect(Object.keys(manifest.dependencies)).not.toContain("@afk/api");
    expect(Object.keys(manifest.dependencies)).not.toContain("pg");
    const sources = fs
      .readdirSync(path.join(dir, "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => fs.readFileSync(path.join(dir, "src", f), "utf8"));
    for (const text of sources) {
      expect(text).not.toMatch(/from\s+["'](pg|@afk\/api|drizzle-orm)/);
    }
    void readFileSync;
  });
});
