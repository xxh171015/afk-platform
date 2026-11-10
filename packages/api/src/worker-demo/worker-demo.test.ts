import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppTokenSource, createGitHubAdapter } from "@afk/host";
import { FakeGitHub } from "@afk/host/testing";
import {
  composePrompt,
  GateCache,
  git,
  gitOut,
  promptFor,
} from "@afk/pipeline";
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
import { importBody } from "../test/ticket-files.ts";

// A whole spec from import to done, with a real Postgres, the HTTP API, real git and slots, and a worker that has
// a fake agent and a fake gate sandbox: no Cursor, no GitHub, no Docker.

// The database's id as these tests set it: the branches of every spec made here carry it.
const ID = "abc123";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;
let logDir: string;
let home: string;
let origin: string; // bare repo standing in for GitHub
let seed: TestRepo;

// The test command counts tests from a file in the repo (3 unless the work says otherwise) and fails on BROKEN.
const COUNT_TESTS =
  "test ! -f BROKEN && mkdir -p reports && n=$(cat tests.count 2>/dev/null || echo 3) && " +
  `printf '<testsuites tests="%s"><testsuite name="a" tests="%s" skipped="0"/></testsuites>' "$n" "$n" > reports/junit.xml`;
const GATES = [
  "commands:",
  "  - name: test",
  `    run: ${JSON.stringify(COUNT_TESTS)}`,
  "    timeoutSeconds: 30",
  "    junit: reports/junit.xml",
  "",
].join("\n");

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  await db.pool.query("UPDATE instance SET id = $1", [ID]);
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
  { flatNames = false } = {},
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
    (
      await post(
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, { tickets }),
      )
    ).status,
  ).toBe(200);
  // a spec made before the databases had ids: its branches have the flat names
  if (flatNames)
    await db.pool.query("UPDATE specs SET branch_namespace = NULL");
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
function deps(
  over: { script?: Script; concurrency?: number; secrets?: string[] } = {},
) {
  const base: Omit<ExecutorDeps, "api"> = {
    slots: new SlotManager({
      root: join(home, "slots"),
      count: 3,
      mainCloneFor: (repo, url) => repos.dirFor(repo, url),
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    }),
    repos: undefined as never,
    snapshots: undefined as never,
    push: (request) => pushRef(request),
    gateCache: new GateCache(),
    makeAgentRunner: (slotDir) =>
      new FakeAgentRunner(slotDir, async (ctx) => {
        const custom = await over.script?.(ctx);
        if (custom) return custom;
        if (ctx.stage === "review" || ctx.stage === "final-review")
          return { output: PASS };
        return {
          files: {
            [`src/agent-${ctx.branch.split("/").at(-1)}.ts`]: `export const ${ctx.stage.replace("-", "")} = 1;\n`,
          },
          message: `${ctx.stage} on ${ctx.branch}`,
          output: DONE,
        };
      }),
    makeGateSandbox: (slotDir) => new FakeGateSandbox(slotDir),
    ...(over.secrets ? { secrets: over.secrets } : {}),
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

describe("a whole spec with a fake agent", { timeout: 60_000 }, () => {
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
    // implement, gate, review, merge: four jobs per ticket, then the overall review
    expect(run.jobs).toBe(9);

    // the integration branch on "GitHub" has both tickets' work, and main was never touched
    expect(
      gitOut(origin, ["show", `spec/${ID}/order-export:src/agent-T-1.ts`]),
    ).toContain("implement");
    expect(
      gitOut(origin, ["show", `spec/${ID}/order-export:src/agent-T-2.ts`]),
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
      `main..spec/${ID}/order-export`,
    ]).split("\n");
    expect(order).toEqual([
      `Merge agent/${ID}/T-1 into spec/${ID}/order-export`,
      `Merge agent/${ID}/T-2 into spec/${ID}/order-export`,
    ]);
    // the ticket branches were pushed, with the traceability trailers on the agent's commits
    for (const [id, run] of [
      ["T-1", "R-1"],
      ["T-2", "R-6"], // a review is two Runs, one per axis
    ]) {
      const body = gitOut(origin, [
        "log",
        "-1",
        "--format=%B",
        `agent/${ID}/${id}`,
      ]);
      expect(body).toContain("Spec: S-1");
      expect(body).toContain(`Ticket: ${id}`);
      expect(body).toContain(`Run: ${run}`);
    }
  });

  it("gives every agent the overlay and its stage's prompt and the ticket file, and records the whole prompt on the Run", async () => {
    await confirmedSpec([ticket("a")]);
    const seen: { stage: string; prompt: string; ticket?: string }[] = [];
    const executor = deps({
      script: (ctx) => {
        seen.push({
          stage: ctx.stage,
          prompt: ctx.prompt,
          ticket: ctx.context("ticket.md"),
        });
        return undefined;
      },
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });

    // a review is two agent runs, one per axis, each with the prompt of its axis
    expect(seen.map((s) => s.stage).sort()).toEqual([
      "final-review",
      "final-review",
      "implement",
      "review",
      "review",
    ]);
    for (const s of seen) {
      const stage = s.stage as "implement" | "review" | "final-review";
      const allowed = (["standards", "spec"] as const).map((axis) =>
        composePrompt(promptFor(stage, { axis })),
      );
      expect(allowed).toContain(s.prompt);
      expect(s.prompt).toContain("没有人会回答你");
    }
    expect(
      seen.filter((s) => s.stage === "review").map((s) => s.prompt),
    ).toEqual(
      expect.arrayContaining([
        composePrompt(promptFor("review", { axis: "standards" })),
        composePrompt(promptFor("review", { axis: "spec" })),
      ]),
    );
    // the agent reads the ticket file the API shows, byte for byte
    const shown = (await fetch(`${api.url}/tickets/1`).then((r) => r.json()))
      .ticket.file;
    expect(seen[0]?.ticket).toBe(shown);
    expect(shown).toContain("id: T-1\nversion: 1\n");
    // and the Run keeps what it was given; gates and merges run no agent and have none
    const runs = await db.pool.query(
      "SELECT stage, prompt FROM runs ORDER BY id",
    );
    expect(runs.rows.filter((r) => r.prompt).map((r) => r.stage)).toEqual([
      "implement",
      "review",
      "review",
      "final-review",
      "final-review",
    ]);
    expect(runs.rows.find((r) => r.stage === "implement")?.prompt).toBe(
      seen[0]?.prompt,
    );
    expect(
      runs.rows
        .filter((r) => r.stage === "gate")
        .every((r) => r.prompt === null),
    ).toBe(true);
  });

  const MUST_FIX = {
    verdict: "fix",
    mustFix: [
      { file: "src/a.ts", line: 2, problem: "the ticket asked for more" },
    ],
    suggestions: [],
    scopeCreep: ["an extra flag"],
    uncertainties: [],
  };
  const isSpecAxis = (prompt: string) =>
    prompt.includes("阶段：review，Spec 轴");

  it("reviews a ticket on two axes at once, fixes what the Spec axis asks for with both results at hand", async () => {
    await confirmedSpec([ticket("a")]);
    let fixSaw: unknown;
    const executor = deps({
      script: (ctx) => {
        if (ctx.stage === "review" && isSpecAxis(ctx.prompt)) {
          return { output: MUST_FIX };
        }
        if (ctx.stage === "review-fix") {
          fixSaw = JSON.parse(ctx.context("review.json") as string);
          return {
            files: { "src/more.ts": "export const more = 1;\n" },
            message: "do what the ticket asked",
            output: DONE,
          };
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
    const reviews = await db.pool.query(
      "SELECT axis, attempt, result FROM runs WHERE stage = 'review' ORDER BY id",
    );
    // one review, a Run per axis; the fix goes on through the gate to the merge, it is not reviewed again
    expect(reviews.rows).toEqual([
      { axis: "standards", attempt: 1, result: "pass" },
      { axis: "spec", attempt: 1, result: "fix" },
    ]);
    // the fix saw the must-fix of the axis that asked, with its axis, and both results as they were
    expect(fixSaw).toMatchObject({
      verdict: "fix",
      mustFix: [{ axis: "spec", file: "src/a.ts" }],
      standards: { verdict: "pass" },
      spec: { scopeCreep: ["an extra flag"] },
    });
    // the scope creep went to the acceptance pack, not to a fix
    const creep = await db.pool.query(
      "SELECT f.resolution, r.axis FROM findings f JOIN runs r ON r.id = f.run_id WHERE f.kind = 'scope-creep'",
    );
    expect(creep.rows).toEqual([
      { resolution: "acceptance-pack", axis: "spec" },
    ]);
  });

  it("takes the failure of one axis as the failure of the whole review, and leaves no branch of the axes behind", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps({
      script: (ctx) =>
        ctx.stage === "review" && isSpecAxis(ctx.prompt)
          ? { error: { kind: "invalid-output", message: "no result" } }
          : undefined,
    });
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:blocked/invalid-output"]);
    const reviews = await db.pool.query(
      "SELECT axis, result FROM runs WHERE stage = 'review' ORDER BY id",
    );
    // each Run says what its own axis came to; the ticket is blocked by the review as a whole
    expect(reviews.rows).toEqual([
      { axis: "standards", result: "pass" },
      { axis: "spec", result: "invalid-output" },
    ]);
    const branches = gitOut(origin, ["branch", "--list", "review-*"]);
    expect(branches).toBe("");
  });

  it("works a spec made before the databases had ids on the flat branch names, start to end", async () => {
    await confirmedSpec(
      [ticket("a"), ticket("b", { blocked_by: ["a"] })],
      {},
      { flatNames: true },
    );
    await runWorker({
      api: workerFor(),
      executor: deps(),
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    expect(
      gitOut(origin, ["log", "--format=%s", "main..spec/order-export"]).split(
        "\n",
      ),
    ).toContain("Merge agent/T-2 into spec/order-export");
    expect(
      git(origin, [
        "rev-parse",
        "--verify",
        "--quiet",
        `spec/${ID}/order-export`,
      ]).code,
    ).not.toBe(0);
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
      ["review", "pass"], // Standards
      ["review", "pass"], // Spec
      ["merge", "merged"],
      ["final-review", "pass"],
      ["final-review", "pass"],
    ]);
    expect(runs.rows.every((r) => r.finished_at !== null)).toBe(true);
    const gates = await db.pool.query(
      "SELECT tests_total, tests_skipped FROM gate_results",
    );
    expect(gates.rows[0]).toEqual({ tests_total: 3, tests_skipped: 0 });

    const logs = await fetch(`${api.url}/runs/${runs.rows[0].id}/logs`).then(
      (r) => r.json(),
    );
    expect(logs.text).toContain(
      `implement: running the agent on agent/${ID}/T-1`,
    );
    expect(logs.text).toContain("result: implement done");
    const findings = await db.pool.query(
      "SELECT kind, resolution FROM findings",
    );
    // each axis of the ticket's review and of the overall review left a suggestion for the acceptance pack
    expect(findings.rows).toEqual(
      Array(4).fill({ kind: "suggestion", resolution: "acceptance-pack" }),
    );
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
      "review:pass",
      "merge:merged",
      "final-review:pass",
      "final-review:pass",
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
            `refs/heads/spec/${ID}/order-export:refs/heads/spec/${ID}/order-export`,
          ]);
          git(ctx.dir, ["merge", "--no-edit", `spec/${ID}/order-export`]);
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
    expect(gitOut(origin, ["show", `spec/${ID}/order-export:shared.txt`])).toBe(
      "settled",
    );
  });
});

describe("the planning commit, end to end", () => {
  it("commits the planning docs onto the planning repo's integration branch first, and other repos' agents read them", async () => {
    // a second repo, and a GLOSSARY in the planning repo
    const front = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "README.md": "# web\n",
    });
    const frontOrigin = join(home, "front.git");
    git(home, ["clone", "--quiet", "--bare", front.dir, frontOrigin]);
    front.cleanup();
    const person = join(home, "person");
    git(home, ["clone", "--quiet", origin, person]);
    writeFileSync(join(person, "GLOSSARY.md"), "# Orders\n");
    git(person, ["add", "-A"]);
    git(person, [
      "-c",
      "user.name=p",
      "-c",
      "user.email=p@x",
      "commit",
      "-qm",
      "glossary",
    ]);
    git(person, ["push", "-q", "origin", "HEAD:main"]);
    // the person's planning: a sharper glossary, not committed
    writeFileSync(
      join(person, "GLOSSARY.md"),
      "# Orders\n\n**Bulk ship**: many at once.\n",
    );
    const patch = git(person, [
      "diff",
      "--binary",
      "--full-index",
      "HEAD",
    ]).stdout;

    const created = await post("/projects", { name: "shop" });
    await post(`/projects/${created.body.id}/repos`, {
      url: origin,
      name: "backend",
    });
    await post(`/projects/${created.body.id}/repos`, {
      url: frontOrigin,
      name: "frontend",
    });
    const spec = await post("/specs", {
      projectId: created.body.id,
      type: "feature",
      slug: "order-export",
      title: "Order export",
      planningRepo: "backend",
    });
    await post(
      `/specs/${spec.body.id}/tickets/import`,
      importBody(spec.body.id, {
        tickets: [ticket("a"), ticket("f", { repo: "frontend" })],
      }),
    );
    expect(
      (await post(`/specs/${spec.body.id}/confirm`, { planningPatch: patch }))
        .status,
    ).toBe(200);

    const seen: Record<string, string | undefined> = {};
    await runWorker({
      api: workerFor(),
      executor: deps({
        script: (ctx) => {
          if (ctx.stage === "implement")
            seen[ctx.branch.split("/").at(-1) as string] =
              ctx.context("domain/GLOSSARY.md");
          return undefined;
        },
      }),
      stopWhenIdle: true,
      heartbeatMs: 50,
    });

    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    const first = gitOut(origin, [
      "log",
      "--format=%an %s",
      "--first-parent",
      "--reverse",
      `main..spec/${ID}/order-export`,
    ]).split("\n")[0];
    expect(first).toBe("afk-worker Planning docs for S-1 Order export");
    expect(
      gitOut(origin, ["show", `spec/${ID}/order-export:GLOSSARY.md`]),
    ).toContain("**Bulk ship**");
    expect(gitOut(origin, ["show", "main:GLOSSARY.md"])).toBe("# Orders");
    // the frontend agent reads the planning docs at the planning commit; the backend one has them in its tree
    expect(seen["T-2"]).toContain("**Bulk ship**");
    expect(seen["T-1"]).toBeUndefined();
  }, 30_000);
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
    const stored = await db.pool.query(
      "SELECT state, error FROM jobs WHERE id = $1",
      [(job as NonNullable<typeof job>).id],
    );
    expect(stored.rows[0].state).toBe("failed");
    expect(stored.rows[0].error).toContain("docker daemon not running");
    // the failed task's clone stays for a look
    expect(
      (await import("node:fs")).readdirSync(join(home, "slots", "0")),
    ).toContain("backend");
  });
});

describe("a person's decisions about a blocked ticket", () => {
  const work = (over?: Parameters<typeof deps>[0]) =>
    runWorker({
      api: workerFor(),
      executor: deps(over),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });

  it("restart starts the ticket again from the integration branch and replaces the old branch", async () => {
    await confirmedSpec([ticket("a")]);
    let implementations = 0;
    const script: Script = (ctx): FakeAgentStep | undefined => {
      if (ctx.stage === "implement") {
        implementations += 1;
        return implementations === 1
          ? {
              files: { BROKEN: "x\n", "OLD.txt": "old\n" },
              message: "old work",
              output: DONE,
            }
          : {
              files: { "src/new.ts": "export {};\n" },
              message: "new work",
              output: DONE,
            };
      }
      if (ctx.stage === "gate-fix")
        return {
          files: { "STILL.txt": "s\n" },
          message: "a fix that fixes nothing",
          output: DONE,
        };
      return undefined;
    };
    await work({ script });
    expect(await stateOf()).toEqual(["1:blocked/gate-failed"]);
    expect(
      gitOut(origin, ["log", "--format=%s", `main..agent/${ID}/T-1`]),
    ).toContain("old work");

    expect((await post("/tickets/1/retry", { mode: "restart" })).status).toBe(
      200,
    );
    await work({ script });
    expect(await stateOf()).toEqual(["1:done"]);
    // the branch on origin is the new attempt only: the old commits are not in it, and not in the integration branch
    expect(
      gitOut(origin, ["log", "--format=%s", `main..agent/${ID}/T-1`]),
    ).toBe("new work");
    for (const gone of ["OLD.txt", "STILL.txt", "BROKEN"]) {
      expect(
        git(origin, ["cat-file", "-e", `spec/${ID}/order-export:${gone}`]).code,
      ).not.toBe(0);
    }
    expect(gitOut(origin, ["show", `spec/${ID}/order-export:src/new.ts`])).toBe(
      "export {};",
    );
  });

  it("continue keeps the branch, so the agent carries on from its earlier commits", async () => {
    await confirmedSpec([ticket("a")]);
    let implementations = 0;
    const script: Script = (ctx): FakeAgentStep | undefined => {
      if (ctx.stage === "implement") {
        implementations += 1;
        if (implementations === 1) {
          return {
            files: { "src/part1.ts": "1\n" },
            message: "part one",
            output: {
              status: "cannot-proceed",
              blockedReason: "agent-gave-up",
              detail: "stuck",
            },
          };
        }
        // the second run finds the first run's commit in its branch? it was never published, so it starts clean
        return {
          files: { "src/part2.ts": "2\n" },
          message: "part two",
          output: DONE,
        };
      }
      return undefined;
    };
    await work({ script });
    expect(await stateOf()).toEqual(["1:blocked/agent-gave-up"]);
    expect((await post("/tickets/1/retry", { mode: "continue" })).status).toBe(
      200,
    );
    await work({ script });
    expect(await stateOf()).toEqual(["1:done"]);
  });

  it("approving protected paths lets the same work through the gate and on to done", async () => {
    await confirmedSpec([ticket("a")]);
    const script: Script = (ctx) =>
      ctx.stage === "implement"
        ? { files: { ".github/workflows/ci.yml": "on: push\n" }, output: DONE }
        : undefined;
    await work({ script });
    expect(await stateOf()).toEqual(["1:blocked/protected-path-changed"]);

    expect((await post("/tickets/1/approve-protected")).status).toBe(200);
    await work({ script });
    expect(await stateOf()).toEqual(["1:done"]);
    expect(
      gitOut(origin, [
        "show",
        `spec/${ID}/order-export:.github/workflows/ci.yml`,
      ]),
    ).toBe("on: push");
    // the agent was not asked again: one implement run
    const stages = await db.pool.query(
      "SELECT stage FROM runs WHERE stage = 'implement'",
    );
    expect(stages.rows).toHaveLength(1);
  });

  it("cancelling a blocked ticket leaves the ones behind it blocked until a person decides", async () => {
    await confirmedSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await work({
      script: (ctx) =>
        ctx.stage === "implement"
          ? {
              output: {
                status: "cannot-proceed",
                blockedReason: "agent-gave-up",
                detail: "no",
              },
            }
          : undefined,
    });
    expect((await post("/tickets/1/cancel", { cascade: false })).status).toBe(
      200,
    );
    expect(await stateOf()).toEqual([
      "1:cancelled",
      "2:blocked/upstream-cancelled",
    ]);
  });
});

describe("work an interrupted run left behind", () => {
  const work = (over?: Parameters<typeof deps>[0]) =>
    runWorker({
      api: workerFor(),
      executor: deps(over),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
  const implementDoneWithoutCommitting: Script = (ctx) =>
    ctx.stage === "implement" ? { output: DONE } : undefined;

  // A commit on agent/T-1 as slot salvage leaves it: in the main clone, and on origin too when the run had pushed.
  function leaveCommit(message: string, published: boolean) {
    const wd = join(home, "salvaged");
    git(home, ["clone", "--quiet", origin, wd]);
    git(wd, ["checkout", "--quiet", "-b", `agent/${ID}/T-1`]);
    writeFileSync(join(wd, "salvaged.ts"), "export const s = 1;\n");
    git(wd, ["add", "."]);
    git(wd, [
      "-c",
      "user.name=agent",
      "-c",
      "user.email=agent@example.com",
      "commit",
      "--quiet",
      "-m",
      message,
    ]);
    const mainClone = new RepoStore(join(home, "repos")).ensure(
      "backend",
      origin,
      "main",
    );
    git(wd, ["push", "--quiet", mainClone, `agent/${ID}/T-1`]);
    if (published) git(wd, ["push", "--quiet", "origin", `agent/${ID}/T-1`]);
    return gitOut(wd, ["rev-parse", "HEAD"]);
  }

  it("counts the commits already in the branch as the implement stage's work, and stamps them", async () => {
    await confirmedSpec([ticket("a")]);
    leaveCommit("salvaged work", false);
    await work({ script: implementDoneWithoutCommitting });
    expect(await stateOf()).toEqual(["1:done"]);
    expect(
      gitOut(origin, ["log", "--format=%B", `main..agent/${ID}/T-1`]),
    ).toContain("Ticket: T-1");
    expect(
      gitOut(origin, ["show", `spec/${ID}/order-export:salvaged.ts`]),
    ).toBe("export const s = 1;");
  });

  it("leaves commits an earlier run already stamped and published as they are", async () => {
    await confirmedSpec([ticket("a")]);
    const tip = leaveCommit(
      "published work\n\nSpec: S-1\nTicket: T-1\nRun: R-99",
      true,
    );
    await work({ script: implementDoneWithoutCommitting });
    expect(await stateOf()).toEqual(["1:done"]);
    expect(gitOut(origin, ["rev-parse", `agent/${ID}/T-1`])).toBe(tip);
    expect(
      gitOut(origin, ["log", "--format=%B", `main..agent/${ID}/T-1`]).match(
        /^Run: /gm,
      ),
    ).toHaveLength(1);
  });

  it("still blocks a done without a commit when the branch has nothing", async () => {
    await confirmedSpec([ticket("a")]);
    await work({ script: implementDoneWithoutCommitting });
    expect(await stateOf()).toEqual(["1:blocked/no-commits"]);
  });
});

describe("the overall review of the integration branch", {
  timeout: 60_000,
}, () => {
  const work = (over?: Parameters<typeof deps>[0]) =>
    runWorker({
      api: workerFor(),
      executor: deps(over),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
  const finalization = async () =>
    (
      await db.pool.query(
        "SELECT step, state, blocked_reason FROM finalizations",
      )
    ).rows;
  const FIX = {
    verdict: "fix",
    mustFix: [
      {
        file: "src/a.ts",
        line: 1,
        problem: "a and b name the same thing differently",
      },
    ],
    suggestions: [],
    uncertainties: [],
  };

  it("reviews the whole spec's diff with every ticket's aim in front of it, and passes", async () => {
    await confirmedSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    let seen: {
      runJson?: { baseSha: string; stage: string; ticket: unknown };
      tickets?: string;
      spec?: string;
      diff?: string;
    } = {};
    await work({
      script: (ctx) => {
        if (ctx.stage !== "final-review") return undefined;
        seen = {
          runJson: JSON.parse(ctx.context("run.json") as string),
          tickets: ctx.context("tickets.md"),
          spec: ctx.context("spec.md"),
          diff: gitOut(ctx.dir, [
            "diff",
            "--name-only",
            `${JSON.parse(ctx.context("run.json") as string).baseSha}..HEAD`,
          ]),
        };
        return { output: PASS };
      },
    });
    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    expect(await finalization()).toEqual([
      { step: "final-review", state: "done", blocked_reason: null },
    ]);
    expect(seen.runJson).toMatchObject({
      stage: "final-review",
      ticket: null,
      baseSha: gitOut(origin, ["rev-parse", "main"]),
    });
    expect(seen.tickets).toContain("T-1 Ticket a");
    expect(seen.tickets).toContain("T-2 Ticket b");
    expect(seen.tickets).toContain("- it works");
    expect(seen.spec).toContain("S-1 Order export");
    // the review sees the work of both tickets together
    expect(seen.diff?.split("\n").sort()).toEqual([
      "src/agent-T-1.ts",
      "src/agent-T-2.ts",
    ]);
    // a passing review changes nothing on the integration branch
    expect(
      gitOut(origin, [
        "log",
        "--format=%s",
        "--first-parent",
        `main..spec/${ID}/order-export`,
      ]).split("\n"),
    ).toHaveLength(2);
  });

  it("makes the one fix the review asks for, merges it through the gate, and stamps it with the spec only", async () => {
    await confirmedSpec([ticket("a"), ticket("b")]);
    let fixSaw: { review?: unknown; tickets?: string } = {};
    await work({
      script: (ctx) => {
        if (ctx.stage === "final-review") return { output: FIX };
        if (ctx.stage === "final-fix") {
          fixSaw = {
            review: JSON.parse(ctx.context("review.json") as string),
            tickets: ctx.context("tickets.md"),
          };
          return {
            files: { "src/shared-name.ts": "export const name = 1;\n" },
            message: "unify the name",
            output: DONE,
          };
        }
        return undefined;
      },
    });
    expect(await finalization()).toEqual([
      { step: "final-merge", state: "done", blocked_reason: null },
    ]);
    expect(fixSaw.review).toMatchObject({ verdict: "fix" });
    expect(fixSaw.tickets).toContain("T-2 Ticket b");
    // the fix is on the integration branch, merged as a candidate that passed the gate
    expect(
      gitOut(origin, ["show", `spec/${ID}/order-export:src/shared-name.ts`]),
    ).toBe("export const name = 1;");
    expect(
      gitOut(origin, ["log", "-1", "--format=%s", `spec/${ID}/order-export`]),
    ).toBe(`Merge agent/${ID}/S-1-final into spec/${ID}/order-export`);
    const trailers = gitOut(origin, [
      "log",
      "-1",
      "--format=%B",
      `agent/${ID}/S-1-final`,
    ]);
    expect(trailers).toContain("Spec: S-1");
    expect(trailers).not.toContain("Ticket:");
    expect(trailers).toMatch(/Run: R-\d+/);
    // each ran once: the gate ran on the merge candidate, review and fix once each
    const stages = await db.pool.query(
      "SELECT stage FROM runs WHERE ticket_id IS NULL ORDER BY id",
    );
    expect(stages.rows.map((r) => r.stage)).toEqual([
      "final-review",
      "final-review",
      "final-fix",
      "final-merge",
    ]);
    // the fix and no ticket's slot is left behind
    const fs = await import("node:fs");
    for (const index of fs.readdirSync(join(home, "slots"))) {
      expect(fs.readdirSync(join(home, "slots", index))).not.toContain(
        "backend",
      );
    }
  });

  it("blocks the spec's finalization when the fix does not pass the gate, and leaves the branch alone", async () => {
    await confirmedSpec([ticket("a")]);
    await work({
      script: (ctx) => {
        if (ctx.stage === "final-review") return { output: FIX };
        if (ctx.stage === "final-fix")
          return {
            files: { BROKEN: "x\n" },
            message: "a fix that breaks the build",
            output: DONE,
          };
        return undefined;
      },
    });
    const before = gitOut(origin, [
      "log",
      "--format=%s",
      "--first-parent",
      `main..spec/${ID}/order-export`,
    ]);
    expect(await finalization()).toEqual([
      {
        step: "final-merge",
        state: "blocked",
        blocked_reason: "post-merge-gate-failed",
      },
    ]);
    expect(
      git(origin, ["cat-file", "-e", `spec/${ID}/order-export:BROKEN`]).code,
    ).not.toBe(0);
    expect(before.split("\n")).toHaveLength(1);
    const queue = await fetch(`${api.url}/blocked`).then((r) => r.json());
    expect(queue.finalizations[0]).toMatchObject({
      step: "final-merge",
      blockedReason: "post-merge-gate-failed",
      brief: { stage: "final-merge", result: "gate-failed" },
    });
    expect(queue.finalizations[0].brief.output.failureLog).toContain(
      "test failed",
    );
  });

  it("a fix that changes a protected path is refused before the gate", async () => {
    await confirmedSpec([ticket("a")]);
    await work({
      script: (ctx) => {
        if (ctx.stage === "final-review") return { output: FIX };
        if (ctx.stage === "final-fix")
          return {
            files: { ".github/workflows/ci.yml": "on: push\n" },
            output: DONE,
          };
        return undefined;
      },
    });
    expect(await finalization()).toEqual([
      {
        step: "final-merge",
        state: "blocked",
        blocked_reason: "post-merge-gate-failed",
      },
    ]);
    const queue = await fetch(`${api.url}/blocked`).then((r) => r.json());
    expect(queue.finalizations[0].brief.output.failureLog).toContain(
      ".github/workflows/ci.yml",
    );
    // only the ticket's own two gates (its branch, and its merge candidate): the fix never reached a gate
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM gate_results")).rows[0]
          .count,
      ),
    ).toBe(2);
  });

  it("an agent that cannot make the fix blocks it with its reason, and a retry of the blocked step can finish it", async () => {
    await confirmedSpec([ticket("a")]);
    let tries = 0;
    const script: Script = (ctx) => {
      if (ctx.stage === "final-review") return { output: FIX };
      if (ctx.stage === "final-fix") {
        tries += 1;
        return tries === 1
          ? {
              output: {
                status: "cannot-proceed",
                blockedReason: "agent-gave-up",
                detail: "unclear which name wins",
              },
            }
          : {
              files: { "src/fix.ts": "export {};\n" },
              message: "the fix",
              output: DONE,
            };
      }
      return undefined;
    };
    await work({ script });
    expect(await finalization()).toEqual([
      { step: "final-fix", state: "blocked", blocked_reason: "agent-gave-up" },
    ]);
    expect((await post("/specs/1/final/retry")).status).toBe(200);
    await work({ script });
    expect(await finalization()).toEqual([
      { step: "final-merge", state: "done", blocked_reason: null },
    ]);
    expect(gitOut(origin, ["show", `spec/${ID}/order-export:src/fix.ts`])).toBe(
      "export {};",
    );
  });
});

describe("the test count guard", () => {
  const work = (over?: Parameters<typeof deps>[0]) =>
    runWorker({
      api: workerFor(),
      executor: deps(over),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });

  it("measures each gate against what the last merge measured: fewer tests than before is a failed gate", async () => {
    await confirmedSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await work({
      script: (ctx) => {
        if (ctx.stage === "implement" && ctx.branch === `agent/${ID}/T-2`) {
          return {
            files: { "tests.count": "2\n" },
            message: "delete a test",
            output: DONE,
          }; // 3 before, 2 now
        }
        if (ctx.stage === "gate-fix")
          return {
            files: { "tests.count": "3\n" },
            message: "put the test back",
            output: DONE,
          };
        return undefined;
      },
    });
    expect(await stateOf()).toEqual(["1:done", "2:done"]);
    const gates = await db.pool.query(
      "SELECT result, output FROM runs WHERE ticket_id = 2 AND stage = 'gate' ORDER BY id",
    );
    expect(gates.rows.map((r) => r.result)).toEqual(["failed", "passed"]);
    expect(gates.rows[0].output.reasons).toEqual([
      "fewer tests than the baseline: 2 < 3",
    ]);
    expect(gates.rows[0].output.failureLog).toContain(
      "fewer tests than the baseline",
    );
  });

  it("does not hold the first ticket of a spec to anything: there is nothing to compare with yet", async () => {
    await confirmedSpec([ticket("a")]);
    await work({
      script: (ctx) =>
        ctx.stage === "implement"
          ? { files: { "tests.count": "1\n" }, output: DONE }
          : undefined,
    });
    expect(await stateOf()).toEqual(["1:done"]);
  });
});

describe("what the project says about a run", () => {
  const work = (over?: Parameters<typeof deps>[0]) =>
    runWorker({
      api: workerFor(),
      executor: deps(over),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });

  it("runs the agent with the project's limits and default model, and records the model on the Run", async () => {
    await confirmedSpec([ticket("a")], {
      defaultModel: "composer-2",
      limits: { runIdleSeconds: 5, runWallclockSeconds: 7 },
    });
    const seen: {
      stage: string;
      idle: number;
      wall: number;
      model?: string;
    }[] = [];
    await work({
      script: (ctx) => {
        seen.push({
          stage: ctx.stage,
          idle: ctx.idleSeconds,
          wall: ctx.wallClockMs,
          model: ctx.model,
        });
        return undefined;
      },
    });
    expect(await stateOf()).toEqual(["1:done"]);
    expect(seen.length).toBeGreaterThan(2); // implement, review, final review
    for (const run of seen)
      expect(run).toMatchObject({ idle: 5, wall: 7000, model: "composer-2" });
    const models = await db.pool.query(
      "SELECT DISTINCT model FROM runs WHERE stage IN ('implement', 'review', 'final-review')",
    );
    expect(models.rows).toEqual([{ model: "composer-2" }]);
  });

  it("uses the defaults, and leaves the model to the worker's own, when the project says nothing", async () => {
    await confirmedSpec([ticket("a")]);
    let seen: { idle: number; wall: number; model?: string } | undefined;
    await work({
      script: (ctx) => {
        seen ??= {
          idle: ctx.idleSeconds,
          wall: ctx.wallClockMs,
          model: ctx.model,
        };
        return undefined;
      },
    });
    expect(seen).toEqual({ idle: 600, wall: 3_600_000, model: undefined });
  });

  it("gives a project that sets no model the worker's own, and the project's model wins when it sets one", async () => {
    await confirmedSpec([ticket("a")]);
    const seen: (string | undefined)[] = [];
    const base = deps({
      script: (ctx) => {
        seen.push(ctx.model);
        return undefined;
      },
    });
    await runWorker({
      api: workerFor(),
      executor: { ...base, model: "worker-model" },
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(new Set(seen)).toEqual(new Set(["worker-model"]));
    const models = await db.pool.query(
      "SELECT DISTINCT model FROM runs WHERE stage = 'implement'",
    );
    expect(models.rows).toEqual([{ model: "worker-model" }]);
  });

  it("records the skills SHA the worker runs on every agent Run, and none on a gate", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker({
      api: workerFor(),
      executor: { ...deps({}), skillsSha: "abc1234" },
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    const agent = await db.pool.query(
      "SELECT DISTINCT skills_sha FROM runs WHERE stage IN ('implement', 'review', 'final-review')",
    );
    expect(agent.rows).toEqual([{ skills_sha: "abc1234" }]);
    const gates = await db.pool.query(
      "SELECT DISTINCT skills_sha FROM runs WHERE stage NOT IN ('implement', 'review', 'final-review', 'fix', 'rework', 'diagnose')",
    );
    expect(gates.rows.every((r) => r.skills_sha === null)).toBe(true);
    expect(gates.rows.length).toBeGreaterThan(0);
  });

  it("prefers the project's model to the worker's own", async () => {
    await confirmedSpec([ticket("a")], { defaultModel: "project-model" });
    const seen: (string | undefined)[] = [];
    const base = deps({
      script: (ctx) => {
        seen.push(ctx.model);
        return undefined;
      },
    });
    await runWorker({
      api: workerFor(),
      executor: { ...base, model: "worker-model" },
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(new Set(seen)).toEqual(new Set(["project-model"]));
  });

  it("uploads Cursor's raw event lines to the Run's log, without the secrets", async () => {
    await confirmedSpec([ticket("a")]);
    const secret = "key_abcdef0123456789";
    await work({
      secrets: [secret],
      script: (ctx) =>
        ctx.stage === "implement"
          ? {
              rawLines: [
                '{"type":"assistant","text":"working on it"}',
                `{"type":"tool","output":"CURSOR_API_KEY=${secret}"}`,
                `x${"y".repeat(200_000)}`,
              ],
              files: { "src/a.ts": "export const a = 1;\n" },
              output: DONE,
            }
          : undefined,
    });
    const run = await db.pool.query(
      "SELECT id FROM runs WHERE stage = 'implement'",
    );
    const text = (
      await fetch(`${api.url}/runs/${run.rows[0].id}/logs`).then((r) =>
        r.json(),
      )
    ).text as string;
    expect(text).toContain('{"type":"assistant","text":"working on it"}');
    expect(text).toContain('"output":"CURSOR_API_KEY=***"');
    expect(text).not.toContain(secret);
    // a line is cut to a sensible size instead of filling the log
    expect(text.length).toBeLessThan(100_000);
    expect(text).toContain("[line cut]");
  });
});

describe("a flood of raw event lines", () => {
  it("is uploaded in pieces the API accepts, up to a limit, and the rest is left out with a note", async () => {
    await confirmedSpec([ticket("a")]);
    // 600 lines of 15 000 characters: more than one chunk, and more than the stage may upload in all
    const lines = Array.from(
      { length: 600 },
      (_, i) => `line-${i}-${"z".repeat(15_000)}`,
    );
    await runWorker({
      api: workerFor(),
      executor: deps({
        script: (ctx) =>
          ctx.stage === "implement"
            ? {
                rawLines: lines,
                files: { "src/a.ts": "export const a = 1;\n" },
                output: DONE,
              }
            : undefined,
      }),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    const run = await db.pool.query(
      "SELECT id FROM runs WHERE stage = 'implement'",
    );
    const stored = readFileSync(
      join(logDir, `run-${run.rows[0].id}`, "attempt-1.log"),
      "utf8",
    );
    expect(stored).toContain("line-0-"); // the first chunk arrived
    expect(stored).toContain("line-400-"); // so did the later ones
    expect(stored).not.toContain("line-599-");
    expect(stored).toContain(
      "raw events beyond the size limit are not uploaded",
    );
    expect(stored.length).toBeLessThan(9 * 1024 * 1024);
    expect(stored).toContain("result: implement done"); // the stage's own lines still got through
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
      `main..spec/${ID}/order-export`,
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
        `main..spec/${ID}/order-export`,
      ]),
    ).toBe("1");
    const jobs = await db.pool.query(
      "SELECT attempt FROM jobs WHERE type = 'merge'",
    );
    expect(jobs.rows[0].attempt).toBe(2);
  });

  it("records the head of a merge it recognises, so the next gate is measured against that merge", async () => {
    await confirmedSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
      ticket("c", { blocked_by: ["b"] }),
    ]);
    const script: Script = (ctx) => {
      // a measures 3 tests (the default), b adds one, c puts the count back to 3
      if (ctx.stage === "implement" && ctx.branch === `agent/${ID}/T-2`)
        return {
          files: { "tests.count": "4\n" },
          message: "add a test",
          output: DONE,
        };
      if (ctx.stage === "implement" && ctx.branch === `agent/${ID}/T-3`)
        return {
          files: { "tests.count": "3\n" },
          message: "drop a test",
          output: DONE,
        };
      if (ctx.stage === "gate-fix")
        return {
          files: { "tests.count": "4\n" },
          message: "put the test back",
          output: DONE,
        };
      return undefined;
    };
    const real = workerFor();
    let merges = 0;
    let lost: number | undefined;
    // the API is unreachable whenever the result of the second merge job (ticket b's) is handed in
    const unreachable = {
      ...real,
      complete: async (
        job: Parameters<typeof real.complete>[0],
        body: unknown,
      ) => {
        if ((body as { stage: string }).stage === "merge") {
          if (lost === undefined && ++merges === 2) lost = job.id;
          if (job.id === lost) throw new Error("connection reset");
        }
        return real.complete(job, body);
      },
    };
    await runWorker({
      api: unreachable,
      executor: deps({ script }),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(await stateOf()).toEqual(["1:done", "2:merging", "3:pending"]);

    clock.advanceSeconds(121); // b's merge job is dispatched again and finds its merge already on the branch
    await runWorker({
      api: workerFor("w2"),
      executor: deps({ script }),
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(await stateOf()).toEqual(["1:done", "2:done", "3:done"]);

    const merge = await db.pool.query(
      `SELECT r.head_sha, g.tests_total FROM runs r
       LEFT JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha
       WHERE r.ticket_id = 2 AND r.stage = 'merge'`,
    );
    expect(merge.rows).toHaveLength(1);
    expect(merge.rows[0].head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(merge.rows[0].tests_total).toBe(4);
    // c's first gate is held to what b's merge measured (4), not to what a's did (3)
    const gates = await db.pool.query(
      "SELECT result, output FROM runs WHERE ticket_id = 3 AND stage = 'gate' ORDER BY id",
    );
    expect(gates.rows.map((r) => r.result)).toEqual(["failed", "passed"]);
    expect(gates.rows[0].output.reasons).toEqual([
      "fewer tests than the baseline: 3 < 4",
    ]);
  }, 30_000); // three tickets, a lost result and a second worker: close to the default limit when the machine is busy

  it("still reports a merge it recognises when the merged head cannot be measured", async () => {
    await confirmedSpec([ticket("a")]);
    const real = workerFor();
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
    clock.advanceSeconds(121);
    const recovering = deps();
    recovering.makeGateSandbox = () => {
      throw new Error("no sandbox for you");
    };
    await runWorker({
      api: workerFor("w2"),
      executor: recovering,
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(await stateOf()).toEqual(["1:done"]);
    const merge = await db.pool.query(
      `SELECT r.head_sha, r.result, g.commit_sha AS measured FROM runs r
       LEFT JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha
       WHERE r.stage = 'merge'`,
    );
    expect(merge.rows).toEqual([
      {
        head_sha: gitOut(origin, ["rev-parse", `spec/${ID}/order-export`]),
        result: "merged",
        measured: null,
      },
    ]);
  });

  it("stops when told to: the job in hand is abandoned, nothing is reported, and no other job is claimed", async () => {
    await confirmedSpec([ticket("a"), ticket("b")]);
    const stop = new AbortController();
    const run = await runWorker({
      api: workerFor(),
      executor: deps({
        // Ctrl-C arrives while the first agent is at work
        script: () => {
          stop.abort();
          return undefined;
        },
      }),
      signal: stop.signal,
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(run.jobs).toBe(1);
    const jobs = await db.pool.query(
      "SELECT state, result FROM jobs ORDER BY id",
    );
    expect(jobs.rows[0]).toEqual({ state: "running", result: null }); // its lease runs out, then it is dispatched again
    expect(
      git(origin, ["rev-parse", "--verify", "--quiet", `agent/${ID}/T-1`]).code,
    ).not.toBe(0);
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
      git(origin, ["rev-parse", "--verify", "--quiet", `agent/${ID}/T-1`]).code,
    ).not.toBe(0);
    expect(gitOut(origin, ["rev-parse", `spec/${ID}/order-export`])).toBe(
      gitOut(origin, ["rev-parse", "main"]),
    );
    expect(await stateOf()).toEqual(["1:running"]);
  });

  // somebody else pushes to the integration branch while a candidate is under test, `times` times
  function withIntruder(executor: ReturnType<typeof deps>, times: number) {
    const intruder = join(home, "intruder");
    let pushed = 0;
    const gateSandbox = executor.makeGateSandbox;
    executor.makeGateSandbox = (slotDir) => {
      const inner = gateSandbox(slotDir);
      return {
        open: async (ref) => {
          if (ref.startsWith("gate/") && pushed < times) {
            pushed += 1;
            rmSync(intruder, { recursive: true, force: true });
            git(home, ["clone", "--quiet", origin, intruder]);
            git(intruder, ["checkout", "--quiet", `spec/${ID}/order-export`]);
            git(intruder, [
              "-c",
              "user.name=X",
              "-c",
              "user.email=x@y",
              "commit",
              "--quiet",
              "--allow-empty",
              "-m",
              `intruder ${pushed}`,
            ]);
            git(intruder, [
              "push",
              "--quiet",
              "origin",
              `spec/${ID}/order-export`,
            ]);
          }
          return inner.open(ref);
        },
      };
    };
    return () => pushed;
  }

  it("fetches and merges again when the integration branch moved while the candidate was being gated", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps();
    const intrusions = withIntruder(executor, 1);
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    expect(intrusions()).toBe(1);
    // nothing was overwritten: the intruder's commit is under our merge, and the ticket is done
    expect(await stateOf()).toEqual(["1:done"]);
    expect(
      gitOut(origin, [
        "log",
        "--format=%s",
        "--first-parent",
        `main..spec/${ID}/order-export`,
      ]).split("\n"),
    ).toEqual([
      `Merge agent/${ID}/T-1 into spec/${ID}/order-export`,
      "intruder 1",
    ]);
    // one merge job did it all, and the candidate that was pushed was gated on the new tip
    const merges = await db.pool.query(
      "SELECT state, attempt FROM jobs WHERE type = 'merge'",
    );
    expect(merges.rows).toEqual([{ state: "done", attempt: 1 }]);
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM gate_results")).rows[0]
          .count,
      ),
    ).toBe(2); // the branch, and the candidate that was pushed
  });

  it("gives up, without overwriting anything, if the branch keeps moving", async () => {
    await confirmedSpec([ticket("a")]);
    const executor = deps();
    withIntruder(executor, 99);
    await runWorker({
      api: workerFor(),
      executor,
      stopWhenIdle: true,
      heartbeatMs: 20,
    });
    // three tries per merge job, and the job itself is tried three times: then the ticket is blocked for a person
    const merges = await db.pool.query(
      "SELECT state, error FROM jobs WHERE type = 'merge' ORDER BY id",
    );
    expect(merges.rows.map((r) => r.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(merges.rows[0].error).toContain("kept moving");
    // nothing of ours reached the branch: the last thing on it is the intruder's
    expect(
      gitOut(origin, ["log", "-1", "--format=%s", `spec/${ID}/order-export`]),
    ).toBe("intruder 9");
    expect(
      gitOut(origin, [
        "log",
        "--format=%s",
        `spec/${ID}/order-export`,
      ]).includes(`Merge agent/${ID}/T-1`),
    ).toBe(false);
    expect(await stateOf()).toEqual(["1:blocked/job-failed"]);
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

describe("from the last ticket to a merged spec, with a fake GitHub", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  let github: FakeGitHub;
  beforeEach(async () => {
    github = new FakeGitHub({
      appId: "5519235",
      installationId: "176373363",
      publicKey,
      owner: "me",
      repo: "afk-pilot-backend",
    });
    await github.start();
  });
  afterEach(() => github.stop());

  const hostWorker = () => {
    const tokens = createAppTokenSource({
      credentials: {
        appId: "5519235",
        installationId: "176373363",
        privateKey,
      },
      apiUrl: github.url,
    });
    const repoRef = () => ({ owner: "me", name: "afk-pilot-backend" });
    return {
      api: workerFor(),
      executor: {
        ...deps(),
        credentials: { tokens, repoRef },
        push: ((request, token) =>
          pushRef(request, token ? { token } : {})) as ExecutorDeps["push"],
      },
      host: {
        adapter: createGitHubAdapter({ tokens, apiUrl: github.url }),
        repoRef,
      },
      stopWhenIdle: true,
      heartbeatMs: 50,
    } satisfies Parameters<typeof runWorker>[0];
  };
  const specState = async () =>
    (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;

  it("opens the pull request, follows it, and marks the spec merged once a person has merged it", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker(hostWorker());

    expect(await specState()).toBe("awaiting-review");
    expect(github.pullRequests()).toMatchObject([
      {
        head: `spec/${ID}/order-export`,
        base: "main",
        title: "S-1 Order export",
      },
    ]);
    expect(github.pullRequests()[0]?.body).toContain("Spec: S-1");
    expect(github.pullRequests()[0]?.body).toContain("- T-1 Ticket a");
    expect(github.pullRequests()[0]?.body).toContain(
      "<!-- afk-acceptance-pack -->",
    );

    // each token was asked for what its job needed, for the one repo, and never for workflows or administration
    const asked = github.tokensIssued.map((t) => t.permissions);
    expect(asked).toContainEqual({ contents: "write" });
    expect(asked).toContainEqual({ pull_requests: "write", contents: "read" });
    expect(asked).toContainEqual({ pull_requests: "write" });
    for (const t of github.tokensIssued) {
      expect(t.repositories).toEqual(["afk-pilot-backend"]);
      expect(Object.keys(t.permissions)).not.toContain("workflows");
      expect(Object.keys(t.permissions)).not.toContain("administration");
    }

    // the next look is a minute away; until then a worker finds nothing
    expect((await runWorker(hostWorker())).jobs).toBe(0);

    // CI and a review show up on the host
    const sha = github.pullRequests()[0]?.sha as string;
    github.setChecks(sha, [{ status: "completed", conclusion: "success" }]);
    github.addReview(1, { user: "ann", state: "APPROVED" });
    await db.pool.query(
      "UPDATE jobs SET not_before = NULL WHERE type = 'host-sync' AND state = 'queued'",
    );
    await runWorker(hostWorker());
    expect(
      (await db.pool.query("SELECT state, ci, review FROM pull_requests")).rows,
    ).toEqual([{ state: "open", ci: "success", review: "approved" }]);
    expect(await specState()).toBe("awaiting-review");

    // a person merges it on GitHub
    github.mergePull(1);
    await db.pool.query(
      "UPDATE jobs SET not_before = NULL WHERE type = 'host-sync' AND state = 'queued'",
    );
    await runWorker(hostWorker());
    expect(await specState()).toBe("merged");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE type = 'host-sync' AND state = 'queued'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  const pullStates = async () =>
    (
      await db.pool.query("SELECT state FROM pull_requests ORDER BY id")
    ).rows.map((r) => r.state);
  const branchesOfTheSpec = () => {
    for (const branch of [
      "main",
      "release/1.0",
      `spec/${ID}/order-export`,
      `agent/${ID}/T-1`,
      `agent/${ID}/S-1-final`,
    ])
      github.addBranch(branch);
  };

  it("closes the open pull request and deletes the branches of a spec that is cancelled, and nothing else", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker(hostWorker());
    expect(await specState()).toBe("awaiting-review");
    branchesOfTheSpec();

    expect((await post("/specs/1/cancel")).status).toBe(200);
    // the clean-up waits for the jobs the cancel stopped to be shut out; here none is running, so no waiting
    await db.pool.query(
      "UPDATE jobs SET not_before = NULL WHERE type = 'spec-cleanup' AND state = 'queued'",
    );
    await runWorker(hostWorker());

    expect(github.pullRequests()[0]).toMatchObject({
      state: "closed",
      merged: false,
    });
    expect(await pullStates()).toEqual(["closed"]);
    expect(github.branches()).toEqual(["main", "release/1.0"]);
    expect(await specState()).toBe("cancelled");
  });

  it("deletes the branches of a spec once it is merged, and leaves the merged pull request as it is", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker(hostWorker());
    branchesOfTheSpec();

    github.mergePull(1);
    await db.pool.query(
      "UPDATE jobs SET not_before = NULL WHERE type = 'host-sync' AND state = 'queued'",
    );
    await runWorker(hostWorker());

    expect(await specState()).toBe("merged");
    expect(github.pullRequests()[0]).toMatchObject({ merged: true });
    expect(github.branches()).toEqual(["main", "release/1.0"]);
  });

  it("lists a pull request closed without merge as waiting for a person, until it is reopened, then goes on to merged", async () => {
    await confirmedSpec([ticket("a")]);
    await runWorker(hostWorker());
    expect(await specState()).toBe("awaiting-review");
    const look = async () => {
      await db.pool.query(
        "UPDATE jobs SET not_before = NULL WHERE type = 'host-sync' AND state = 'queued'",
      );
      await runWorker(hostWorker());
    };
    const waiting = async () =>
      (
        (await (await fetch(`${api.url}/blocked`)).json()) as {
          pullRequests: { specDisplayId: string; state: string }[];
        }
      ).pullRequests;

    github.closePull(1); // closed on GitHub, not merged
    await look();
    expect(await waiting()).toMatchObject([
      { specDisplayId: "S-1", state: "closed" },
    ]);
    expect(await specState()).toBe("awaiting-review");

    github.reopenPull(1);
    await look();
    expect(await waiting()).toEqual([]);
    expect(await specState()).toBe("awaiting-review");

    github.closePull(1);
    await look();
    expect(await waiting()).toHaveLength(1);
    github.reopenPull(1);
    github.mergePull(1); // reopened, then merged by a person
    await look();
    expect(await waiting()).toEqual([]);
    expect(await specState()).toBe("merged");
  });

  it("is not done by a worker that has no code host: it leaves the jobs alone", async () => {
    await confirmedSpec([ticket("a")]);
    const plain = hostWorker();
    await runWorker({
      api: plain.api,
      executor: plain.executor,
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(await specState()).toBe("finalizing");
    expect(github.pullRequests()).toEqual([]);
    expect(
      (await db.pool.query("SELECT state FROM jobs WHERE type = 'open-pr'"))
        .rows,
    ).toEqual([{ state: "queued" }]);
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
