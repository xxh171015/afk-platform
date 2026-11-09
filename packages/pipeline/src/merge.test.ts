import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImplementOutputSchema, PROMPTS } from "./agent.ts";
import { git, gitOut } from "./exec.ts";
import { hasRef, isAncestor, mergeCandidate, trialMerge } from "./merge.ts";
import { FakeAgentRunner } from "./testing/fakes.ts";
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

  it("keeps Spec and Run trailers on a merge of the default branch into the integration branch", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    git(repo.dir, ["checkout", "--quiet", "main"]);
    repo.commit({ "main.txt": "m\n" }, "main moved");
    const result = mergeCandidate(
      repo.dir,
      "spec/s",
      "main",
      "Merge main into spec/s\n\nSpec: S-1\nRun: R-4",
    );
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    expect(
      gitOut(repo.dir, ["log", "-1", "--format=%B", result.candidate]).trim(),
    ).toBe("Merge main into spec/s\n\nSpec: S-1\nRun: R-4");
  });

  it("merges a temp branch that already merged main into the integration branch with Spec and Run trailers", () => {
    diverged({ "agent.txt": "a\n" }, { "other.txt": "o\n" });
    git(repo.dir, ["checkout", "--quiet", "main"]);
    repo.commit({ "main.txt": "m\n" }, "main moved");
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/S-1-update", "spec/s"]);
    expect(git(repo.dir, ["merge", "--no-edit", "main"]).code).toBe(0);
    const result = mergeCandidate(
      repo.dir,
      "spec/s",
      "agent/S-1-update",
      "Merge agent/S-1-update into spec/s\n\nSpec: S-1\nRun: R-5",
    );
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    expect(
      gitOut(repo.dir, ["log", "-1", "--format=%B", result.candidate]).trim(),
    ).toBe("Merge agent/S-1-update into spec/s\n\nSpec: S-1\nRun: R-5");
    expect(isAncestor(repo.dir, "main", result.candidate)).toBe(true);
  });

  it("lets a fake merge agent resolve main into a temp branch, then merge-tree that into the spec", async () => {
    repo = makeRepo({ "shared.txt": "line\n" });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    repo.commit({ "shared.txt": "spec line\n" }, "spec work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    repo.commit({ "shared.txt": "main line\n" }, "main moved");
    expect(mergeCandidate(repo.dir, "spec/s", "main", "m").conflict).toBe(true);

    const ctxDir = mkdtempSync(join(tmpdir(), "afk-ub-ctx-"));
    writeFileSync(join(ctxDir, "run.json"), "{}");
    const runner = new FakeAgentRunner(repo.dir, (ctx) => {
      git(ctx.dir, ["merge", "--no-edit", "main"]);
      return {
        files: { "shared.txt": "both\n" },
        output: {
          status: "done",
          summary: "merged main",
          acceptance: {},
          uncertainties: [],
        },
      };
    });
    const run = await runner.run({
      stage: "update-branch",
      branch: "agent/S-1-update",
      baseBranch: "spec/s",
      promptFile: PROMPTS.updateBranch,
      ctxDir,
      schema: ImplementOutputSchema,
      idleSeconds: 600,
      wallClockMs: 60_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.commits.length).toBeGreaterThan(0);
    const result = mergeCandidate(
      repo.dir,
      "spec/s",
      "agent/S-1-update",
      "Merge agent/S-1-update into spec/s\n\nSpec: S-1\nRun: R-5",
    );
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    expect(
      gitOut(repo.dir, ["log", "-1", "--format=%B", result.candidate]).trim(),
    ).toBe("Merge agent/S-1-update into spec/s\n\nSpec: S-1\nRun: R-5");
    expect(isAncestor(repo.dir, "main", result.candidate)).toBe(true);
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

describe("trialMerge", () => {
  it("names the files two integration branches would conflict on, and does not make a commit", () => {
    repo = makeRepo({ "shared.txt": "line\n" });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/a"]);
    repo.commit({ "shared.txt": "a\n" }, "a");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/b"]);
    repo.commit({ "shared.txt": "b\n" }, "b");
    const before = gitOut(repo.dir, ["rev-list", "--all", "--count"]);

    expect(trialMerge(repo.dir, "spec/a", "spec/b")).toEqual({
      files: ["shared.txt"],
    });
    expect(gitOut(repo.dir, ["rev-list", "--all", "--count"])).toBe(before);
  });

  it("returns no files when the branches do not conflict", () => {
    repo = makeRepo({ "shared.txt": "line\n" });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/a"]);
    repo.commit({ "a.txt": "a\n" }, "a");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/b"]);
    repo.commit({ "b.txt": "b\n" }, "b");

    expect(trialMerge(repo.dir, "spec/a", "spec/b")).toEqual({ files: [] });
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
