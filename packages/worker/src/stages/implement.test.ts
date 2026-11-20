import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_UPSTREAM_ENV, git, gitOrThrow, gitOut } from "@afk/pipeline";
import {
  bundleFor,
  FakeAgentRunner,
  type FakeAgentStep,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { TicketAlign } from "../align-ticket-branch.ts";
import type { ClaimedJob } from "../api.ts";
import type { ExecutorDeps, StageOutcomeBody } from "../executor.ts";
import { pushRef } from "../push.ts";
import { RepoStore } from "../repos.ts";
import type { Slot } from "../slots.ts";
import { SnapshotStore } from "../snapshots.ts";
import { agentChange } from "./implement.ts";

const GATES = [
  "commands:",
  "  - name: test",
  '    run: "true"',
  "    timeoutSeconds: 30",
  "",
].join("\n");

const DONE = {
  status: "done",
  summary: "merged",
  acceptance: {},
  decisions: [],
};

const job: ClaimedJob = {
  id: 7,
  type: "agent-run",
  payload: {},
  attempt: 1,
  lockKey: null,
  leaseExpiresAt: "2099-01-01T00:00:00Z",
};

const align: TicketAlign = { expectedOld: "" };

let repo: TestRepo;
let origin: string;
let slotDir: string;
let tmp: string;
afterEach(() => {
  repo?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function body(rev: string) {
  return gitOut(repo.dir, ["log", "-1", "--format=%B", rev]);
}

function originAndSlot(branches: string[] = ["spec/s"]) {
  tmp = mkdtempSync(join(tmpdir(), "afk-implement-"));
  origin = join(tmp, "origin.git");
  git(tmp, ["clone", "--quiet", "--bare", repo.dir, origin]);
  git(repo.dir, ["remote", "add", "origin", origin]);
  slotDir = join(tmp, "slot");
  git(tmp, ["clone", "--quiet", "--no-hardlinks", repo.dir, slotDir]);
  for (const branch of branches) {
    git(slotDir, ["branch", branch, `origin/${branch}`]);
  }
}

function slot(ref: string): Slot {
  return {
    index: 0,
    dir: slotDir,
    task: {
      jobId: 7,
      attempt: 1,
      repo: "backend",
      ref,
    },
    release: async () => {},
  };
}

function context(
  bundle: ReturnType<typeof bundleFor>,
  payload: Record<string, unknown> = {},
): {
  job: ClaimedJob;
  bundle: ReturnType<typeof bundleFor>;
  signal: AbortSignal;
  log: () => void;
  logRaw: () => void;
} {
  return {
    job: { ...job, payload },
    bundle,
    signal: new AbortController().signal,
    log: () => {},
    logRaw: () => {},
  };
}

type RecheckFacts = {
  hit: boolean;
  paths: string[];
  fromSha: string;
  toSha: string;
};

function recheckOf(outcome: StageOutcomeBody): RecheckFacts {
  const run = outcome.run;
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error("missing recheck");
  }
  return (run as { recheck: RecheckFacts }).recheck;
}

function deps(runner: FakeAgentRunner): ExecutorDeps {
  return {
    slots: null as unknown as ExecutorDeps["slots"],
    repos: new RepoStore(join(tmp, "repos")),
    snapshots: new SnapshotStore(join(tmp, "snapshots")),
    push: (request) => pushRef(request),
    api: {
      prePush: async () => "held",
      gateResult: async () => undefined,
    },
    makeAgentRunner: () => runner,
    makeGateSandbox: (dir) => new FakeGateSandbox(dir),
    tmpRoot: tmp,
  };
}

describe("agentChange trailers after merging another branch", () => {
  it("update-branch: default-branch commits keep their hashes; only the agent's merge commit gets Spec and Run", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "base.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "spec.txt": "spec\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit({ "from-main.txt": "main\n" }, "main moved");
    originAndSlot();

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return { output: DONE };
    });
    const bundle = bundleFor({
      stage: "update-branch",
      ticket: null,
      agentBranch: "agent/S-12-update",
      integrationBranch: "spec/s",
    });
    const outcome = await agentChange(
      deps(runner),
      context(bundle),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    expect(outcome.outcome).toBe("done");
    expect(gitOut(repo.dir, ["rev-parse", "main"])).toBe(mainTip);
    expect(
      git(repo.dir, [
        "merge-base",
        "--is-ancestor",
        "main",
        "agent/S-12-update",
      ]).code,
    ).toBe(0);
    expect(body("main")).not.toContain("Spec:");
    expect(body("main")).not.toContain("Run:");
    expect(body("agent/S-12-update")).toContain("Spec: S-12");
    expect(body("agent/S-12-update")).toContain("Run: R-9");
    expect(body("agent/S-12-update")).not.toContain("Ticket:");
    const parents = gitOut(repo.dir, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "agent/S-12-update",
    ])
      .split(" ")
      .slice(1);
    expect(parents[1]).toBe(mainTip);
  });

  it("merge-fix: integration-branch commits keep their hashes and do not get Spec or Run", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "shared.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit({ "ticket.txt": "ticket\n" }, "ticket work");
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    const integrationTip = repo.commit(
      { "other.txt": "other\n" },
      "another ticket merged",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/s"]);
      return { output: DONE };
    });
    const bundle = bundleFor({
      stage: "merge-fix",
      agentBranch: "agent/T-123",
      integrationBranch: "spec/s",
    });
    const outcome = await agentChange(
      deps(runner),
      context(bundle),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(gitOut(repo.dir, ["rev-parse", "spec/s"])).toBe(integrationTip);
    expect(
      git(repo.dir, ["merge-base", "--is-ancestor", "spec/s", "agent/T-123"])
        .code,
    ).toBe(0);
    expect(body("spec/s")).not.toContain("Ticket:");
    expect(body("spec/s")).not.toContain("Spec:");
    expect(body("agent/T-123")).toContain("Ticket: T-123");
    expect(body("agent/T-123")).toContain("Spec: S-12");
  });

  it("implement: commits merged in from another spec/* branch keep their hashes on origin", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "base.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/aa0001/other", "main"]);
    const otherTip = repo.commit(
      { "other.txt": "from other spec\n" },
      "other spec work\n\nSpec: S-51\nTicket: T-100\nRun: R-800",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "spec/aa0001/other"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/aa0001/other"]);
      return { files: { "ticket.txt": "ticket work\n" }, output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "implement",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      align,
    );

    expect(outcome.outcome).toBe("done");
    expect(
      git(origin, ["merge-base", "--is-ancestor", otherTip, "agent/T-123"])
        .code,
    ).toBe(0);
    expect(gitOut(origin, ["log", "-1", "--format=%B", otherTip])).toContain(
      "Spec: S-51",
    );
    expect(gitOut(origin, ["log", "-1", "--format=%B", otherTip])).toContain(
      "Ticket: T-100",
    );
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", otherTip]),
    ).not.toContain("Spec: S-12");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", otherTip]),
    ).not.toContain("Ticket: T-123");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/T-123"]),
    ).toContain("Ticket: T-123");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/T-123"]),
    ).toContain("Spec: S-12");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/T-123"]),
    ).toContain("Run: R-9");
  });

  it("final-fix: commits merged in from another spec/* branch keep their hashes on origin", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "base.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/S-12-final"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/aa0001/other", "main"]);
    const otherTip = repo.commit(
      { "other.txt": "from other spec\n" },
      "other spec work\n\nSpec: S-51\nTicket: T-100\nRun: R-800",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/S-12-final", "spec/aa0001/other"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/S-12-final"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/aa0001/other"]);
      return { files: { "final.txt": "final work\n" }, output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "final-fix",
          ticket: null,
          agentBranch: "agent/S-12-final",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/S-12-final"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(
      git(origin, ["merge-base", "--is-ancestor", otherTip, "agent/S-12-final"])
        .code,
    ).toBe(0);
    expect(gitOut(origin, ["log", "-1", "--format=%B", otherTip])).toContain(
      "Spec: S-51",
    );
    expect(gitOut(origin, ["log", "-1", "--format=%B", otherTip])).toContain(
      "Ticket: T-100",
    );
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", otherTip]),
    ).not.toContain("Spec: S-12");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/S-12-final"]),
    ).toContain("Spec: S-12");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/S-12-final"]),
    ).toContain("Run: R-9");
    expect(
      gitOut(origin, ["log", "-1", "--format=%B", "agent/S-12-final"]),
    ).not.toContain("Ticket:");
  });
});

describe("AFK_GENERATED_UPSTREAM_SHA in the agent sandbox", () => {
  it("update-branch sets it to the default branch tip", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "base.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "spec.txt": "spec\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit({ "from-main.txt": "main\n" }, "main moved");
    originAndSlot();

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return { output: DONE };
    });
    await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "update-branch",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    expect(runner.calls[0]?.env?.[GENERATED_UPSTREAM_ENV]).toBe(mainTip);
  });

  it("merge-fix sets it to the integration branch tip", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "shared.txt": "base\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit({ "ticket.txt": "ticket\n" }, "ticket work");
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    const integrationTip = repo.commit(
      { "other.txt": "other\n" },
      "another ticket merged",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/s"]);
      return { output: DONE };
    });
    await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "merge-fix",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(runner.calls[0]?.env?.[GENERATED_UPSTREAM_ENV]).toBe(integrationTip);
  });
});

describe("Recheck range after update-branch and merge-fix", () => {
  it("update-branch: does not hit when main flips an existing test and the agent leaves it", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/feature.ts": "1\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "main flips assertion",
    );
    originAndSlot();

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return { output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "update-branch",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
        }),
        { mainSha: mainTip },
      ),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: false,
      paths: [],
    });
  });

  it("update-branch: hits when the agent drops main's test lines in a conflict", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("shared", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(1));\nit("spec", () => expect(true).toBe(true));\n',
      },
      "spec adds a test",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(2));\nit("main", () => expect(true).toBe(true));\n',
      },
      "main flips assertion",
    );
    originAndSlot();

    const resolved =
      'it("shared", () => expect(n).toBe(1));\nit("spec", () => expect(true).toBe(true));\n';
    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      writeFileSync(join(ctx.dir, "src/a.test.ts"), resolved);
      return { files: { "src/a.test.ts": resolved }, output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "update-branch",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
        }),
        { mainSha: mainTip },
      ),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
    });
  });

  it("update-branch: hits when the agent edits an existing spec-side test after the auto-merge", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/feature.ts": "1\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit({ "src/from-main.ts": "1\n" }, "main moves");
    originAndSlot();

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return {
        files: {
          "src/a.test.ts": 'it("is 1", () => expect(n).toBe(9));\n',
        },
        output: DONE,
      };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "update-branch",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
        }),
        { mainSha: mainTip },
      ),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
    });
  });

  it("merge-fix: does not hit when the integration branch flips an existing test and the agent leaves it", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit({ "src/ticket.ts": "1\n" }, "ticket work");
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "integration flips assertion",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/s"]);
      return { output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "merge-fix",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: false,
      paths: [],
    });
  });

  it("merge-fix: hits when the agent drops the integration branch's test lines in a conflict", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("shared", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(1));\nit("ticket", () => expect(true).toBe(true));\n',
      },
      "ticket adds a test",
    );
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(2));\nit("integration", () => expect(true).toBe(true));\n',
      },
      "integration flips assertion",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);

    const resolved =
      'it("shared", () => expect(n).toBe(1));\nit("ticket", () => expect(true).toBe(true));\n';
    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/s"]);
      writeFileSync(join(ctx.dir, "src/a.test.ts"), resolved);
      return { files: { "src/a.test.ts": resolved }, output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "merge-fix",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
    });
  });

  it("merge-fix: hits when the agent edits an existing ticket-side test after the auto-merge", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit({ "src/ticket.ts": "1\n" }, "ticket work");
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    repo.commit({ "src/from-int.ts": "1\n" }, "integration moves");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "spec/s"]);
      return {
        files: {
          "src/a.test.ts": 'it("is 1", () => expect(n).toBe(9));\n',
        },
        output: DONE,
      };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "merge-fix",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
    });
  });

  it("review-fix Recheck still starts at the pre-run tip", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);
    const before = gitOut(repo.dir, ["rev-parse", "agent/T-123"]);

    const runner = new FakeAgentRunner(slotDir, async () => ({
      files: {
        "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n',
      },
      output: DONE,
    }));
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "review-fix",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha: before,
    });
  });

  it("final-fix Recheck still starts at the pre-run tip", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/S-12-final"]);
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/S-12-final"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/S-12-final"]);
    const before = gitOut(repo.dir, ["rev-parse", "agent/S-12-final"]);

    const runner = new FakeAgentRunner(slotDir, async () => ({
      files: {
        "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n',
      },
      output: DONE,
    }));
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "final-fix",
          ticket: null,
          agentBranch: "agent/S-12-final",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/S-12-final"),
      { expectedOld: remoteTip, remoteTip },
    );

    expect(outcome.outcome).toBe("done");
    expect(recheckOf(outcome)).toMatchObject({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha: before,
    });
  });

  it("stores the auto-merge commit as fromSha under refs/afk/recheck and git diff reaches it", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/feature.ts": "1\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    const mainTip = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "main flips assertion",
    );
    originAndSlot();

    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return { output: DONE };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "update-branch",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
        }),
        { mainSha: mainTip },
      ),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );

    const trigger = recheckOf(outcome);
    const stored = gitOrThrow(repo.dir, ["rev-parse", "refs/afk/recheck/R-9"]);
    expect(trigger.fromSha).toBe(stored);
    expect(trigger.fromSha).not.toBe(mainTip);
    expect(gitOrThrow(repo.dir, ["cat-file", "-t", trigger.fromSha])).toBe(
      "commit",
    );
    expect(git(repo.dir, ["diff", trigger.fromSha, trigger.toSha]).code).toBe(
      0,
    );
  });
});

describe("result format repair", () => {
  it("implement: an invalid first result that a repair run fixes is done with the first run's commits, resultFix repaired, and the repair tokens added", async () => {
    repo = makeRepo({ ".sandcastle/gates.yaml": GATES });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s", "agent/T-123"]);
    const remoteTip = gitOut(origin, ["rev-parse", "agent/T-123"]);
    const firstUsage = { inputTokens: 10, outputTokens: 4 };
    const repairUsage = { inputTokens: 3, outputTokens: 2 };
    const runner = new FakeAgentRunner(slotDir, (ctx): FakeAgentStep => {
      if (ctx.prompt.includes("不要重做这个阶段")) {
        return {
          files: { "repair-should-not-land.txt": "no\n" },
          output: {
            status: "done",
            summary: "did it",
            acceptance: {},
            decisions: [],
          },
          rawLines: [JSON.stringify({ type: "result", usage: repairUsage })],
        };
      }
      return {
        files: { "src/a.ts": "export {};\n" },
        output: { status: "done" },
        rawLines: [JSON.stringify({ type: "result", usage: firstUsage })],
      };
    });
    const outcome = await agentChange(
      deps(runner),
      context(
        bundleFor({
          stage: "implement",
          agentBranch: "agent/T-123",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("agent/T-123"),
      { expectedOld: remoteTip, remoteTip },
    );
    expect(outcome.outcome).toBe("done");
    expect(outcome.run).toMatchObject({
      resultFix: "repaired",
      tokenUsage: { inputTokens: 13, outputTokens: 6 },
    });
    const commits = (outcome.run as { commits: string[] }).commits;
    expect(commits.length).toBeGreaterThan(0);
    expect(
      git(repo.dir, [
        "cat-file",
        "-e",
        "agent/T-123:repair-should-not-land.txt",
      ]).code,
    ).not.toBe(0);
    expect(git(repo.dir, ["cat-file", "-e", "agent/T-123:src/a.ts"]).code).toBe(
      0,
    );
    expect(runner.calls).toHaveLength(2);
  });
});
