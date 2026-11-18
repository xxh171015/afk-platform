import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOut } from "@afk/pipeline";
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
import type { ExecutorDeps, StageOutcomeBody } from "../executor.ts";
import { pushRef } from "../push.ts";
import { RepoStore } from "../repos.ts";
import type { Slot } from "../slots.ts";
import { SnapshotStore } from "../snapshots.ts";
import { agentChange } from "./implement.ts";
import { recheck } from "./recheck.ts";

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

const PASS = {
  verdict: "pass" as const,
  mustFix: [],
  suggestions: [],
  scopeCreep: [],
  uncertainties: [],
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

function originAndSlot(branches: string[] = ["spec/s"]) {
  tmp = mkdtempSync(join(tmpdir(), "afk-recheck-"));
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

describe("recheck.json fromSha after update-branch", () => {
  it("is the auto-merge commit and the sandbox can git diff it", async () => {
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

    let trigger: RecheckFacts | null = null;
    const seen: { fromSha?: string; diffCode?: number; kind?: string }[] = [];
    const runner = new FakeAgentRunner(slotDir, async (ctx) => {
      if (ctx.stage === "update-branch") {
        git(ctx.dir, ["merge", "--no-edit", "main"]);
        return { output: DONE };
      }
      const listed = ctx.context("recheck.json");
      const hit = listed
        ? (JSON.parse(listed) as {
            fromSha: string;
            toSha: string;
            paths: string[];
          })
        : undefined;
      const kind = hit
        ? git(ctx.dir, ["cat-file", "-t", hit.fromSha]).stdout.trim()
        : "";
      const diffCode = hit
        ? git(ctx.dir, ["diff", hit.fromSha, hit.toSha]).code
        : -1;
      seen.push({ fromSha: hit?.fromSha, diffCode, kind });
      return { output: PASS };
    });

    const updateBundle = bundleFor({
      stage: "update-branch",
      ticket: null,
      agentBranch: "agent/S-12-update",
      integrationBranch: "spec/s",
    });
    const update = await agentChange(
      deps(runner),
      context(updateBundle, { mainSha: mainTip }),
      repo.dir,
      slot("agent/S-12-update"),
      align,
    );
    trigger = recheckOf(update);
    expect(trigger?.fromSha).toBeTruthy();

    const recheckBundle = bundleFor({
      stage: "recheck",
      ticket: null,
      agentBranch: "agent/S-12-update",
      integrationBranch: "spec/s",
      recheck: trigger,
    });
    const outcome = await recheck(
      deps(runner),
      context(recheckBundle, {
        fromSha: trigger?.fromSha,
        toSha: trigger?.toSha,
        paths: trigger?.paths,
      }),
      repo.dir,
      slot("agent/S-12-update"),
    );

    expect(outcome.outcome).toBe("pass");
    expect(seen).toEqual([
      {
        fromSha: trigger?.fromSha,
        kind: "commit",
        diffCode: 0,
      },
    ]);
    expect(gitOut(repo.dir, ["rev-parse", "refs/afk/recheck/R-9"])).toBe(
      trigger?.fromSha,
    );
  });

  it("reconstructs the auto-merge commit in a clone that never stored refs/afk/recheck", async () => {
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

    const updateRunner = new FakeAgentRunner(slotDir, async (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return { output: DONE };
    });
    const update = await agentChange(
      deps(updateRunner),
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
    const trigger = recheckOf(update);
    expect(trigger.fromSha).toBeTruthy();

    const otherRoot = join(tmp, "other");
    git(tmp, ["clone", "--quiet", "--no-hardlinks", origin, otherRoot]);
    git(otherRoot, ["branch", "spec/s", "origin/spec/s"]);
    git(otherRoot, ["branch", "agent/S-12-update", "origin/agent/S-12-update"]);
    const otherSlot = join(tmp, "other-slot");
    git(tmp, ["clone", "--quiet", "--no-hardlinks", otherRoot, otherSlot]);
    git(otherSlot, ["branch", "spec/s", "origin/spec/s"]);
    git(otherSlot, ["branch", "agent/S-12-update", "origin/agent/S-12-update"]);

    const seen: { kind: string; diffCode: number }[] = [];
    const recheckRunner = new FakeAgentRunner(otherSlot, async (ctx) => {
      const listed = ctx.context("recheck.json");
      const hit = JSON.parse(listed ?? "{}") as {
        fromSha: string;
        toSha: string;
      };
      seen.push({
        kind: git(ctx.dir, ["cat-file", "-t", hit.fromSha]).stdout.trim(),
        diffCode: git(ctx.dir, ["diff", hit.fromSha, hit.toSha]).code,
      });
      return { output: PASS };
    });
    const outcome = await recheck(
      deps(recheckRunner),
      context(
        bundleFor({
          stage: "recheck",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
          recheck: trigger,
        }),
        {
          fromSha: trigger.fromSha,
          toSha: trigger.toSha,
          paths: trigger.paths,
        },
      ),
      otherRoot,
      {
        index: 0,
        dir: otherSlot,
        task: {
          jobId: 7,
          attempt: 1,
          repo: "backend",
          ref: "agent/S-12-update",
        },
        release: async () => {},
      },
    );

    expect(outcome.outcome).toBe("pass");
    expect(seen).toEqual([{ kind: "commit", diffCode: 0 }]);
  });
});

describe("result format repair after update-branch", () => {
  it("Recheck after following main: an invalid first result that a repair run fixes is pass with resultFix repaired", async () => {
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
      if (ctx.stage === "update-branch") {
        git(ctx.dir, ["merge", "--no-edit", "main"]);
        return { output: DONE };
      }
      if (ctx.prompt.includes("不要重做这个阶段")) {
        return { output: PASS };
      }
      return { output: { verdict: "pass" } };
    });

    const update = await agentChange(
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
    const trigger = recheckOf(update);

    const outcome = await recheck(
      deps(runner),
      context(
        bundleFor({
          stage: "recheck",
          ticket: null,
          agentBranch: "agent/S-12-update",
          integrationBranch: "spec/s",
          recheck: trigger,
        }),
        {
          fromSha: trigger.fromSha,
          toSha: trigger.toSha,
          paths: trigger.paths,
        },
      ),
      repo.dir,
      slot("agent/S-12-update"),
    );

    expect(outcome.outcome).toBe("pass");
    expect(outcome.run).toMatchObject({ resultFix: "repaired" });
    expect(
      runner.calls.filter((call) => call.stage === "recheck"),
    ).toHaveLength(2);
  });
});
