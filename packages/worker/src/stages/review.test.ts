import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@afk/pipeline";
import {
  bundleFor,
  FakeAgentRunner,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaimedJob } from "../api.ts";
import type { ExecutorDeps } from "../executor.ts";
import { pushRef } from "../push.ts";
import { RepoStore } from "../repos.ts";
import type { Slot } from "../slots.ts";
import { SnapshotStore } from "../snapshots.ts";
import { review } from "./review.ts";

const PASS = {
  verdict: "pass" as const,
  mustFix: [] as { file: string; line?: number; problem: string }[],
  suggestions: [] as string[],
  scopeCreep: [] as string[],
  uncertainties: [] as string[],
};

const job: ClaimedJob = {
  id: 7,
  type: "agent-run",
  payload: {},
  attempt: 1,
  lockKey: null,
  leaseExpiresAt: "2099-01-01T00:00:00Z",
};

let repo: TestRepo;
let origin: string;
let slotDir: string;
let tmp: string;
afterEach(() => {
  repo?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function originAndSlot(branches: string[] = ["spec/s"]) {
  tmp = mkdtempSync(join(tmpdir(), "afk-review-"));
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

describe("result format repair", () => {
  it("final-review: an invalid first result that a repair run fixes is pass with resultFix repaired", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "commands:",
        "  - name: test",
        '    run: "true"',
        "    timeoutSeconds: 30",
        "",
      ].join("\n"),
      "src/a.ts": "export const n = 1;\n",
      "AGENTS.md": "Use named exports.\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "spec work");
    originAndSlot(["spec/s"]);
    const runner = new FakeAgentRunner(slotDir, (ctx) => {
      if (ctx.prompt.includes("不要重做这个阶段")) {
        return {
          output: ctx.prompt.includes("Standards")
            ? { ...PASS, sources: ["AGENTS.md"] }
            : PASS,
        };
      }
      return { output: { verdict: "pass" } };
    });
    const outcome = await review(
      deps(runner),
      context(
        bundleFor({
          stage: "final-review",
          ticket: null,
          agentBranch: "agent/S-12-final",
          integrationBranch: "spec/s",
        }),
      ),
      repo.dir,
      slot("spec/s"),
    );
    expect(outcome.outcome).toBe("pass");
    expect(outcome.run).toMatchObject({ resultFix: "repaired" });
    expect(outcome.extraRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: expect.objectContaining({ resultFix: "repaired" }),
        }),
      ]),
    );
    expect(runner.calls.length).toBeGreaterThanOrEqual(4);
  });
});
