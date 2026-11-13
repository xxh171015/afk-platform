import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  alignTicketBranch,
  deleteOrphanRefs,
  handbackResumeStage,
  orphanRefFor,
} from "./align-ticket-branch.ts";

let local: TestRepo;
let remoteRoot: string;
let remote: string;

beforeEach(() => {
  local = makeRepo();
  remoteRoot = mkdtempSync(join(tmpdir(), "afk-align-"));
  remote = join(remoteRoot, "origin.git");
  git(remoteRoot, ["clone", "--quiet", "--bare", local.dir, remote]);
  git(local.dir, ["remote", "add", "origin", remote]);
});
afterEach(() => {
  local.cleanup();
  rmSync(remoteRoot, { recursive: true, force: true });
});

const BRANCH = "agent/T-1";
const HEADS = `refs/heads/${BRANCH}`;
const INTEGRATION = "spec/s-1";
const shaOf = (dir: string, ref: string) => gitOrThrow(dir, ["rev-parse", ref]);

function commit(dir: string, file: string, message: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), `${message}\n`);
  gitOrThrow(dir, ["add", "-A"]);
  gitOrThrow(dir, ["commit", "--quiet", "-m", message]);
  return gitOrThrow(dir, ["rev-parse", "HEAD"]);
}

function cloneWork(name: string): string {
  const wd = join(remoteRoot, name);
  gitOrThrow(remoteRoot, ["clone", "--quiet", remote, wd]);
  gitOrThrow(wd, ["config", "user.email", "test@example.com"]);
  gitOrThrow(wd, ["config", "user.name", "Test"]);
  gitOrThrow(wd, ["config", "commit.gpgsign", "false"]);
  gitOrThrow(wd, ["checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`]);
  return wd;
}

describe("alignTicketBranch", () => {
  it("expects an empty remote when the ticket branch does not exist yet", () => {
    expect(alignTicketBranch(local.dir, BRANCH)).toEqual({ expectedOld: "" });
  });

  it("fast-forwards a local branch that origin has moved ahead of", () => {
    gitOrThrow(local.dir, ["branch", BRANCH]);
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    const first = shaOf(local.dir, HEADS);
    const wd = cloneWork("ahead");
    const remoteTip = commit(wd, "ahead.txt", "ahead");
    gitOrThrow(wd, ["push", "--quiet", "origin", BRANCH]);
    expect(shaOf(local.dir, HEADS)).toBe(first);
    expect(alignTicketBranch(local.dir, BRANCH)).toEqual({
      expectedOld: remoteTip,
      remoteTip,
    });
    expect(shaOf(local.dir, HEADS)).toBe(remoteTip);
  });

  it("keeps a local tip that is strictly ahead of origin", () => {
    gitOrThrow(local.dir, ["branch", BRANCH]);
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    const remoteTip = shaOf(local.dir, HEADS);
    gitOrThrow(local.dir, ["symbolic-ref", "HEAD", HEADS]);
    const localTip = commit(local.dir, "local.txt", "local ahead");
    expect(alignTicketBranch(local.dir, BRANCH)).toEqual({
      expectedOld: remoteTip,
      remoteTip,
    });
    expect(shaOf(local.dir, HEADS)).toBe(localTip);
  });

  it("keeps a diverged local tip as an orphan ref and follows origin", () => {
    gitOrThrow(local.dir, ["branch", BRANCH]);
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    gitOrThrow(local.dir, ["symbolic-ref", "HEAD", HEADS]);
    const localTip = commit(local.dir, "local.txt", "local line");
    const wd = cloneWork("other");
    const remoteTip = commit(wd, "other.txt", "origin line");
    gitOrThrow(wd, ["push", "--quiet", "origin", BRANCH]);

    const aligned = alignTicketBranch(local.dir, BRANCH);
    const orphan = orphanRefFor(BRANCH, localTip);
    expect(aligned).toEqual({
      expectedOld: remoteTip,
      remoteTip,
      orphan: { ref: orphan, sha: localTip },
    });
    expect(shaOf(local.dir, HEADS)).toBe(remoteTip);
    expect(shaOf(local.dir, orphan)).toBe(localTip);
    expect(
      git(remote, ["show-ref", "--verify", "--quiet", orphan]).code,
    ).not.toBe(0);
  });

  it("drops the local branch on a restart and expects origin's current tip", () => {
    gitOrThrow(local.dir, ["branch", BRANCH]);
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    const remoteTip = shaOf(local.dir, HEADS);
    expect(alignTicketBranch(local.dir, BRANCH, { restart: true })).toEqual({
      expectedOld: remoteTip,
      remoteTip,
    });
    expect(
      git(local.dir, ["show-ref", "--verify", "--quiet", HEADS]).code,
    ).not.toBe(0);
  });

  it("picks handback resume from the remote tip", () => {
    gitOrThrow(local.dir, ["checkout", "--quiet", "-b", INTEGRATION]);
    const integrationTip = commit(local.dir, "spec/base.txt", "integration");
    gitOrThrow(local.dir, ["branch", BRANCH]);
    const ticketTip = commit(local.dir, "ticket.txt", "ticket work");
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    expect(handbackResumeStage(local.dir, BRANCH, INTEGRATION, "feature")).toBe(
      "gate",
    );
    gitOrThrow(local.dir, [
      "push",
      "--quiet",
      "origin",
      `:refs/heads/${BRANCH}`,
    ]);
    gitOrThrow(local.dir, ["update-ref", "-d", HEADS]);
    expect(handbackResumeStage(local.dir, BRANCH, INTEGRATION, "feature")).toBe(
      "implement",
    );
    gitOrThrow(local.dir, ["update-ref", HEADS, ticketTip]);
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    gitOrThrow(local.dir, ["checkout", "--quiet", INTEGRATION]);
    gitOrThrow(local.dir, ["merge", "--quiet", "--ff-only", BRANCH]);
    expect(
      handbackResumeStage(local.dir, BRANCH, INTEGRATION, "integration"),
    ).toBe("e2e");
    gitOrThrow(local.dir, ["checkout", "--quiet", BRANCH]);
    commit(local.dir, "more.txt", "more work");
    gitOrThrow(local.dir, ["push", "--quiet", "origin", `${HEADS}:${HEADS}`]);
    expect(
      handbackResumeStage(local.dir, BRANCH, INTEGRATION, "integration"),
    ).toBe("gate");
    void integrationTip;
  });

  it("deletes orphan refs of the given branches", () => {
    gitOrThrow(local.dir, ["branch", BRANCH]);
    const sha = shaOf(local.dir, HEADS);
    const orphan = orphanRefFor(BRANCH, sha);
    gitOrThrow(local.dir, ["update-ref", orphan, sha]);
    expect(deleteOrphanRefs(local.dir, [BRANCH])).toEqual([orphan]);
    expect(
      git(local.dir, ["show-ref", "--verify", "--quiet", orphan]).code,
    ).not.toBe(0);
  });
});
