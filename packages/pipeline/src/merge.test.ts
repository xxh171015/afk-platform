import { afterEach, describe, expect, it } from "vitest";
import { git, gitOut } from "./exec.ts";
import { hasRef, isAncestor, mergeCandidate } from "./merge.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo;
afterEach(() => repo.cleanup());

// main has moved on (a file from another ticket); agent/T-1 forked earlier
function diverged(
  agentFile: Record<string, string>,
  mainFile: Record<string, string>,
) {
  repo = makeRepo({ "shared.txt": "line\n" });
  git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
  git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
  repo.commit(agentFile, "ticket work");
  git(repo.dir, ["checkout", "--quiet", "spec/s"]);
  repo.commit(mainFile, "another ticket merged");
}

describe("mergeCandidate", () => {
  it("builds a merge commit from refs alone when there is no conflict", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    const specBefore = gitOut(repo.dir, ["rev-parse", "spec/s"]);
    const agentBefore = gitOut(repo.dir, ["rev-parse", "agent/T-1"]);

    const result = mergeCandidate(
      repo.dir,
      "spec/s",
      "agent/T-1",
      "candidate for T-1",
    );
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    // parents are the integration branch first, the ticket branch second
    expect(
      gitOut(repo.dir, ["rev-list", "--parents", "-n", "1", result.candidate])
        .split(" ")
        .slice(1),
    ).toEqual([specBefore, agentBefore]);
    expect(
      gitOut(repo.dir, ["ls-tree", "-r", "--name-only", result.candidate])
        .split("\n")
        .sort(),
    ).toEqual(["agent.txt", "other.txt", "shared.txt"]);
    expect(
      gitOut(repo.dir, ["log", "-1", "--format=%s", result.candidate]),
    ).toBe("candidate for T-1");
  });

  it("gives the candidate an author even when git has no identity configured", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    git(repo.dir, ["config", "--unset", "user.name"]);
    git(repo.dir, ["config", "--unset", "user.email"]);
    const result = mergeCandidate(repo.dir, "spec/s", "agent/T-1", "m");
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    expect(
      gitOut(repo.dir, ["log", "-1", "--format=%an <%ae>", result.candidate]),
    ).toBe("afk-worker <afk-worker@users.noreply.github.com>");
  });

  it("moves no branch and checks nothing out", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    const refsBefore = gitOut(repo.dir, ["for-each-ref"]);
    mergeCandidate(repo.dir, "spec/s", "agent/T-1", "m");
    expect(gitOut(repo.dir, ["for-each-ref"])).toBe(refsBefore);
    expect(gitOut(repo.dir, ["status", "--porcelain"])).toBe("");
    expect(gitOut(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "spec/s",
    );
  });

  it("tells a conflict from a clean merge and names the conflicting files", () => {
    diverged({ "shared.txt": "agent line\n" }, { "shared.txt": "main line\n" });
    const result = mergeCandidate(repo.dir, "spec/s", "agent/T-1", "m");
    expect(result.conflict).toBe(true);
    if (!result.conflict) return;
    expect(result.files).toEqual(["shared.txt"]);
  });

  it("is an error, not a conflict, when a ref does not exist", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    expect(() => mergeCandidate(repo.dir, "spec/s", "agent/nope", "m")).toThrow(
      /merge-tree failed/,
    );
  });
});

describe("isAncestor and hasRef", () => {
  it("knows when the ticket branch is already part of the integration branch", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    expect(isAncestor(repo.dir, "agent/T-1", "spec/s")).toBe(false);
    git(repo.dir, ["merge", "--quiet", "--no-edit", "agent/T-1"]);
    expect(isAncestor(repo.dir, "agent/T-1", "spec/s")).toBe(true);
  });

  it("tells whether a ref exists", () => {
    repo = makeRepo();
    expect(hasRef(repo.dir, "main")).toBe(true);
    expect(hasRef(repo.dir, "agent/none")).toBe(false);
  });
});
