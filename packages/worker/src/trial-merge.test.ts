import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RepoStore } from "./repos.ts";
import { runTrialMerge, type TrialMergeTask } from "./trial-merge.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function origin(): TestRepo {
  const repo = makeRepo({ "shared.txt": "line\n" });
  git(repo.dir, ["checkout", "--quiet", "-b", "spec/a"]);
  repo.commit({ "shared.txt": "a\n" }, "a");
  git(repo.dir, ["checkout", "--quiet", "main"]);
  git(repo.dir, ["checkout", "--quiet", "-b", "spec/b"]);
  repo.commit({ "shared.txt": "b\n" }, "b");
  git(repo.dir, ["checkout", "--quiet", "main"]);
  git(repo.dir, ["checkout", "--quiet", "-b", "spec/c"]);
  repo.commit({ "c.txt": "c\n" }, "c");
  cleanups.push(() => repo.cleanup());
  return repo;
}

const task = (
  repo: TestRepo,
  peers: TrialMergeTask["peers"],
): TrialMergeTask => ({
  spec: { id: 1, displayId: "S-1", title: "A" },
  repo: { name: "backend", url: repo.dir, defaultBranch: "main" },
  ours: { specId: 1, branch: "spec/a" },
  peers,
});

describe("trial-merge", () => {
  it("reports conflicting files against a peer, and skips a peer whose branch is gone", () => {
    const repo = origin();
    const repos = new RepoStore(tmp("afk-trial-merge-"));
    const result = runTrialMerge(
      { repos },
      task(repo, [
        { specId: 2, branch: "spec/b" },
        { specId: 3, branch: "spec/gone" },
        { specId: 4, branch: "spec/c" },
      ]),
      () => {},
    );
    expect(result.stage).toBe("trial-merge");
    expect(
      result.peers.map((peer) => peer.specId).sort((a, b) => a - b),
    ).toEqual([2, 4]);
    const againstB = result.peers.find((peer) => peer.specId === 2);
    expect(againstB?.files).toEqual(["shared.txt"]);
    expect(againstB?.ourSha).toBe(
      gitOrThrow(repo.dir, ["rev-parse", "spec/a"]),
    );
    expect(againstB?.theirSha).toBe(
      gitOrThrow(repo.dir, ["rev-parse", "spec/b"]),
    );
    expect(result.peers.find((peer) => peer.specId === 4)?.files).toEqual([]);
  });
});
