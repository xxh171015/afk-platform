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
    // the stage ran to an answer, so the slot is clean again even though the ticket is blocked
    const fs = await import("node:fs");
    for (const index of fs.readdirSync(join(home, "slots"))) {
      expect(fs.readdirSync(join(home, "slots", index))).not.toContain(
        "backend",
      );
    }
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

describe("the merge stage", () => {
  it("recognises a merge it already did when the result never reached the API", async () => {
    await confirmedSpec([ticket("a")]);
    const real = workerFor();
    // the API is unreachable exactly when the merge result is handed in
    const unreachable = {
      ...real,
      complete: async (
        job: Parameters<typeof real.complete>[0],
        body: unknown,
      ) => {
        if ((body as { stage: string }).stage === "merge")
          throw new Error("connection reset");
        return real.complete(job, body);
      },
    };
    await runWorker({
      api: unreachable,
      executor: deps(),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(await stateOf()).toEqual(["1:merging"]);
    const mergesAfterFirst = gitOut(origin, [
      "rev-list",
      "--count",
      "--merges",
      "main..spec/order-export",
    ]);
    expect(mergesAfterFirst).toBe("1"); // it did push

    clock.advanceSeconds(121); // the lease of the merge job runs out, another attempt takes it
    await runWorker({
      api: workerFor("w2"),
      executor: deps(),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(await stateOf()).toEqual(["1:done"]);
    // merged once, not twice
    expect(
      gitOut(origin, [
        "rev-list",
        "--count",
        "--merges",
        "main..spec/order-export",
      ]),
    ).toBe("1");
    const jobs = await db.pool.query(
      "SELECT attempt FROM jobs WHERE type = 'merge'",
    );
    expect(jobs.rows[0].attempt).toBe(2);
  });

  it("pushes nothing when the lease is gone at the pre-push check", async () => {
    await confirmedSpec([ticket("a")]);
    const real = workerFor();
    const losing = { ...real, prePush: async () => "lost" as const };
    await runWorker({
      api: losing,
      executor: deps(),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    // the agent branch was never published either: the very first pre-push (before the implement push) said lost
    expect(
      git(origin, ["rev-parse", "--verify", "--quiet", "agent/T-1"]).code,
    ).not.toBe(0);
    expect(gitOut(origin, ["rev-parse", "spec/order-export"])).toBe(
      gitOut(origin, ["rev-parse", "main"]),
    );
    expect(await stateOf()).toEqual(["1:running"]);
  });

  it("does not overwrite an integration branch that moved while the candidate was being gated", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps();
    const intruder = join(home, "intruder");
    const gateSandbox = executor.makeGateSandbox;
    executor.makeGateSandbox = (slotDir) => {
      const inner = gateSandbox(slotDir);
      return {
        open: async (ref) => {
          if (ref.startsWith("gate/")) {
            // somebody else pushes to the integration branch while the candidate is under test
            git(home, ["clone", "--quiet", origin, intruder]);
            git(intruder, ["checkout", "--quiet", "spec/order-export"]);
            git(intruder, [
              "-c",
              "user.name=X",
              "-c",
              "user.email=x@y",
              "commit",
              "--quiet",
              "--allow-empty",
              "-m",
              "intruder",
            ]);
            git(intruder, ["push", "--quiet", "origin", "spec/order-export"]);
          }
          return inner.open(ref);
        },
      };
    };
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    // the push was refused by the lease: the intruder's commit is still the tip, our merge is not there
    expect(
      gitOut(origin, ["log", "-1", "--format=%s", "spec/order-export"]),
    ).toBe("intruder");
    const merge = await db.pool.query(
      "SELECT state, error FROM jobs WHERE type = 'merge'",
    );
    expect(merge.rows[0].state).toBe("failed");
    expect(merge.rows[0].error).toContain("could not advance");
    expect(await stateOf()).toEqual(["1:merging"]); // not done: nothing reached the integration branch
  });
});

describe("trouble reaching the API, or no room to work", () => {
  const claimed = async (api2 = workerFor()) => {
    await confirmedSpec([ticket("a")]);
    return {
      api2,
      job: (await api2.claim([])) as NonNullable<
        Awaited<ReturnType<typeof api2.claim>>
      >,
    };
  };

  it("leaves the job alone, not failed, when every slot is taken", async () => {
    const { api2, job } = await claimed();
    const executor = deps();
    executor.slots = new SlotManager({
      root: join(home, "full-slots"),
      count: 0,
      mainCloneFor: () => seed.dir,
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    });
    expect(
      await processJob({ api: api2, executor, heartbeatMs: 50 }, job),
    ).toBe("abandoned");
    const stored = await db.pool.query("SELECT state FROM jobs WHERE id = $1", [
      job.id,
    ]);
    expect(stored.rows[0].state).toBe("running"); // the lease will run out and the job comes back
  });

  it("retries handing in the result when the API hiccups, and does not throw the facts away", async () => {
    const { api2, job } = await claimed();
    let tries = 0;
    const flaky = {
      ...api2,
      complete: async (j: typeof job, body: unknown) => {
        tries += 1;
        if (tries < 3) throw new Error("the API answered 503");
        return api2.complete(j, body);
      },
    };
    expect(
      await processJob({ api: flaky, executor: deps(), heartbeatMs: 50 }, job),
    ).toBe("completed");
    expect(tries).toBe(3);
    expect((await stateOf())[0]).toBe("1:running");
  });

  it("gives the job up without failing it when the result cannot be handed in at all", async () => {
    const { api2, job } = await claimed();
    let failCalled = false;
    const down = {
      ...api2,
      complete: async () => {
        throw new Error("connection refused");
      },
      fail: async () => {
        failCalled = true;
        return "held" as const;
      },
    };
    expect(
      await processJob({ api: down, executor: deps(), heartbeatMs: 50 }, job),
    ).toBe("abandoned");
    expect(failCalled).toBe(false);
  });

  it("stops working when the heartbeat keeps failing", async () => {
    const { api2, job } = await claimed();
    let sawAbort = false;
    const flaky = {
      ...api2,
      heartbeat: async () => {
        throw new Error("network down");
      },
    };
    const executor = deps({
      script: async (ctx) => {
        if (ctx.stage !== "implement") return undefined;
        await new Promise<void>((resolve) =>
          ctx.signal?.addEventListener("abort", () => resolve()),
        );
        sawAbort = true;
        return { output: DONE };
      },
    });
    expect(
      await processJob({ api: flaky, executor, heartbeatMs: 20 }, job),
    ).toBe("abandoned");
    expect(sawAbort).toBe(true);
  });

  it("uploads the log while the stage is still running", async () => {
    const { api2, job } = await claimed();
    let seenWhileRunning = "";
    const executor = deps({
      script: async (ctx) => {
        if (ctx.stage !== "implement") return undefined;
        await new Promise((resolve) => setTimeout(resolve, 300)); // long enough for a flush
        const runId = (
          await db.pool.query("SELECT id FROM runs WHERE job_id = $1", [job.id])
        ).rows[0].id;
        seenWhileRunning = (
          await fetch(`${api.url}/runs/${runId}/logs`).then((r) => r.json())
        ).text;
        return undefined;
      },
    });
    await processJob(
      { api: api2, executor, heartbeatMs: 50, logFlushMs: 40 },
      job,
    );
    expect(seenWhileRunning).toContain("implement: running the agent");
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
