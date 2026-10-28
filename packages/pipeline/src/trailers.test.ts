import { afterEach, describe, expect, it } from "vitest";
import { git, gitOut } from "./exec.ts";
import { makeRepo, type TestRepo, tmpPath } from "./testing/repo.ts";
import { stampTrailers } from "./trailers.ts";

let repo: TestRepo;
afterEach(() => repo.cleanup());

const ids = { spec: "S-12", ticket: "T-123", run: "R-456" };
const body = (rev: string) =>
  gitOut(repo.dir, ["log", "-1", "--format=%B", rev]);

function agentBranch() {
  repo = makeRepo();
  const base = gitOut(repo.dir, ["rev-parse", "main"]);
  git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
  repo.commit({ "a.txt": "1\n" }, "first change");
  // Cursor adds its own trailer to the commits it makes
  repo.commit(
    { "b.txt": "2\n" },
    "second change\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
  );
  git(repo.dir, ["checkout", "--quiet", "main"]);
  return base;
}

describe("stampTrailers", () => {
  it("adds Spec, Ticket and Run to every new commit and keeps Cursor's Co-authored-by", () => {
    const base = agentBranch();
    const result = stampTrailers(
      repo.dir,
      "agent/T-123",
      base,
      ids,
      tmpPath("stamp", repo),
    );
    expect(result).toEqual({ rewritten: 2 });
    for (const rev of ["agent/T-123", "agent/T-123~1"]) {
      expect(body(rev)).toContain("Spec: S-12");
      expect(body(rev)).toContain("Ticket: T-123");
      expect(body(rev)).toContain("Run: R-456");
    }
    expect(body("agent/T-123")).toContain(
      "Co-authored-by: Cursor <cursoragent@cursor.com>",
    );
    // the commits still sit on the same base, in the same order
    expect(
      gitOut(repo.dir, ["log", "--format=%s", `${base}..agent/T-123`]),
    ).toBe("second change\nfirst change");
  });

  it("leaves the base and the main branch alone, and cleans up its temporary worktree", () => {
    const base = agentBranch();
    stampTrailers(repo.dir, "agent/T-123", base, ids, tmpPath("stamp", repo));
    expect(gitOut(repo.dir, ["rev-parse", "main"])).toBe(base);
    expect(gitOut(repo.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("does nothing when the branch has no new commits", () => {
    repo = makeRepo();
    const base = gitOut(repo.dir, ["rev-parse", "main"]);
    git(repo.dir, ["branch", "agent/T-1"]);
    expect(
      stampTrailers(repo.dir, "agent/T-1", base, ids, tmpPath("stamp", repo)),
    ).toEqual({ rewritten: 0 });
  });

  it("does not repeat a trailer when stamping a second time", () => {
    const base = agentBranch();
    stampTrailers(repo.dir, "agent/T-123", base, ids, tmpPath("stamp", repo));
    stampTrailers(repo.dir, "agent/T-123", base, ids, tmpPath("stamp", repo));
    expect(body("agent/T-123").match(/^Spec: S-12$/gm)).toHaveLength(1);
  });

  it("only takes our own id formats, because they end up in a shell command", () => {
    const base = agentBranch();
    expect(() =>
      stampTrailers(
        repo.dir,
        "agent/T-123",
        base,
        { ...ids, ticket: "T-1'; rm -rf /; '" },
        tmpPath("stamp", repo),
      ),
    ).toThrow(/not a ticket id/);
    expect(() =>
      stampTrailers(
        repo.dir,
        "agent/T-123",
        base,
        { ...ids, spec: "T-1" },
        tmpPath("stamp", repo),
      ),
    ).toThrow(/not a spec id/);
  });

  it("reports a rebase that cannot be done and leaves the branch as it was", () => {
    const base = agentBranch();
    const tip = gitOut(repo.dir, ["rev-parse", "agent/T-123"]);
    // a branch that is checked out elsewhere cannot get a second worktree
    git(repo.dir, ["checkout", "--quiet", "agent/T-123"]);
    const result = stampTrailers(
      repo.dir,
      "agent/T-123",
      base,
      ids,
      tmpPath("stamp", repo),
    );
    expect(result.rewritten).toBe(0);
    expect(result.error).toMatch(/worktree add failed/);
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123"])).toBe(tip);
  });
});
