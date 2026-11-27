import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@afk/pipeline";
import {
  bundleFor,
  FakeAgentRunner,
  FakeDocker,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaimedJob } from "../api.ts";
import { EnvironmentLimiter } from "../environments.ts";
import { type ExecutorDeps, InfrastructureError } from "../executor.ts";
import { pushRef } from "../push.ts";
import { RepoStore } from "../repos.ts";
import type { Slot } from "../slots.ts";
import { SnapshotStore } from "../snapshots.ts";
import { diagnose } from "./diagnose.ts";

const GATES = [
  "commands:",
  "  - name: test",
  '    run: "true"',
  "    timeoutSeconds: 30",
  "",
].join("\n");

const DIAGNOSED = {
  result: "fail" as const,
  failingRepo: "backend",
  evidence: "GET /orders/1/export answers 404: the route is not registered",
  failingTests: ["downloads the export"],
};

const CRASH = { kind: "other" as const, message: "Error: Premature close" };

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
  tmp = mkdtempSync(join(tmpdir(), "afk-diagnose-"));
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
  logs?: string[],
): {
  job: ClaimedJob;
  bundle: ReturnType<typeof bundleFor>;
  signal: AbortSignal;
  log: (line: string) => void;
  logRaw: () => void;
} {
  return {
    job,
    bundle,
    signal: new AbortController().signal,
    log: logs ? (line) => logs.push(line) : () => {},
    logRaw: () => {},
  };
}

function deps(runner: FakeAgentRunner): ExecutorDeps {
  const docker = new FakeDocker();
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
    docker: docker.cli,
    environments: new EnvironmentLimiter(),
    tmpRoot: tmp,
  };
}

describe("recover after an abnormal agent exit", () => {
  it("diagnose: an abnormal exit with a valid result file is diagnosed with resultFix recovered-after-exit", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.ts": "export const n = 1;\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s"]);
    const logs: string[] = [];
    const runner = new FakeAgentRunner(slotDir, (ctx) => {
      expect(readdirSync(ctx.resultDir as string)).toEqual([]);
      return {
        resultFile: DIAGNOSED,
        uncommitted: { "src/dirty.ts": "left behind\n" },
        error: CRASH,
      };
    });
    const outcome = await diagnose(
      deps(runner),
      context(
        bundleFor({
          stage: "diagnose",
          integrationBranch: "spec/s",
          agentBranch: "agent/T-123",
        }),
        logs,
      ),
      repo.dir,
      slot("spec/s"),
    );
    expect(outcome.outcome).toBe("diagnosed");
    expect(outcome.run).toMatchObject({
      resultFix: "recovered-after-exit",
      output: expect.objectContaining({
        failingRepo: "backend",
        error: CRASH.message,
      }),
    });
    expect(outcome.diagnosis).toMatchObject({
      failingRepo: "backend",
      evidence: DIAGNOSED.evidence,
    });
    expect(logs).toContain("agent 进程异常退出，平台按它已写好的结果收下");
  });

  it("diagnose: an abnormal exit with an invalid result is a job failure", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.ts": "export const n = 1;\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s"]);
    const runner = new FakeAgentRunner(slotDir, () => ({
      resultFile: { result: "fail" },
      error: CRASH,
    }));
    await expect(
      diagnose(
        deps(runner),
        context(
          bundleFor({
            stage: "diagnose",
            integrationBranch: "spec/s",
            agentBranch: "agent/T-123",
          }),
        ),
        repo.dir,
        slot("spec/s"),
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("diagnose: reads <result> from the last assistant message when the result file is missing", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": GATES,
      "src/a.ts": "export const n = 1;\n",
    });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "src/a.ts": "export const n = 2;\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    originAndSlot(["spec/s"]);
    const runner = new FakeAgentRunner(slotDir, () => ({
      rawLines: [
        JSON.stringify({
          type: "assistant",
          message: {
            content: `<result>\n${JSON.stringify(DIAGNOSED)}\n</result>`,
          },
        }),
      ],
      error: CRASH,
    }));
    const outcome = await diagnose(
      deps(runner),
      context(
        bundleFor({
          stage: "diagnose",
          integrationBranch: "spec/s",
          agentBranch: "agent/T-123",
        }),
      ),
      repo.dir,
      slot("spec/s"),
    );
    expect(outcome.outcome).toBe("diagnosed");
    expect(outcome.run).toMatchObject({
      resultFix: "recovered-after-exit",
      output: expect.objectContaining({ failingRepo: "backend" }),
    });
  });
});
