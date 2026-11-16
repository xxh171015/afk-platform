import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_UPSTREAM_ENV, git, gitOut } from "@afk/pipeline";
import {
  bundleFor,
  FakeAgentRunner,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { TicketAlign } from "../align-ticket-branch.ts";
import type { ClaimedJob } from "../api.ts";
import type { ExecutorDeps } from "../executor.ts";
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

function context(bundle: ReturnType<typeof bundleFor>): {
  job: ClaimedJob;
  bundle: ReturnType<typeof bundleFor>;
  signal: AbortSignal;
  log: () => void;
  logRaw: () => void;
} {
  return {
    job,
    bundle,
    signal: new AbortController().signal,
    log: () => {},
    logRaw: () => {},
  };
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
