import { afterEach, describe, expect, it } from "vitest";
import { git, gitOut } from "./exec.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";
import { stampTrailers } from "./trailers.ts";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

const ids = { spec: "S-12", ticket: "T-123", run: "R-456" };
const body = (rev: string) =>
  gitOut(repo.dir, ["log", "-1", "--format=%B", rev]);
const stamp = (
  before: string,
  over: Partial<Parameters<typeof stampTrailers>[0]> = {},
) =>
  stampTrailers({
    repoDir: repo.dir,
    branch: "agent/T-123",
    before,
    ids,
    ...over,
  });

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
    expect(stamp(base)).toEqual({ rewritten: 2 });
    for (const rev of ["agent/T-123", "agent/T-123~1"]) {
      expect(body(rev)).toContain("Spec: S-12");
      expect(body(rev)).toContain("Ticket: T-123");
      expect(body(rev)).toContain("Run: R-456");
    }
    expect(body("agent/T-123")).toContain(
      "Co-authored-by: Cursor <cursoragent@cursor.com>",
    );
    // the commits still sit on the same base, in the same order, with the same content
    expect(
      gitOut(repo.dir, ["log", "--format=%s", `${base}..agent/T-123`]),
    ).toBe("second change\nfirst change");
    expect(gitOut(repo.dir, ["show", "agent/T-123:b.txt"])).toBe("2");
  });

  it("keeps each commit's author and author date; the platform is only the committer", () => {
    const base = agentBranch();
    git(repo.dir, ["checkout", "--quiet", "agent/T-123"]);
    git(repo.dir, [
      "commit",
      "--quiet",
      "--allow-empty",
      "--author",
      "Ada <ada@example.com>",
      "--date",
      "2026-01-02T03:04:05Z",
      "-m",
      "by ada",
    ]);
    git(repo.dir, ["checkout", "--quiet", "main"]);
    stamp(base);
    expect(
      gitOut(repo.dir, [
        "log",
        "-1",
        "--format=%an <%ae> %aI | %cn",
        "agent/T-123",
      ]),
    ).toBe("Ada <ada@example.com> 2026-01-02T03:04:05+00:00 | afk-worker");
  });

  it("leaves the base and the main branch alone and needs no worktree", () => {
    const base = agentBranch();
    stamp(base);
    expect(gitOut(repo.dir, ["rev-parse", "main"])).toBe(base);
    expect(gitOut(repo.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("does nothing when the branch has no new commits", () => {
    repo = makeRepo();
    const base = gitOut(repo.dir, ["rev-parse", "main"]);
    git(repo.dir, ["branch", "agent/T-123"]);
    expect(stamp(base)).toEqual({ rewritten: 0 });
  });

  it("does not repeat a trailer when stamping a second time", () => {
    const base = agentBranch();
    stamp(base);
    const once = gitOut(repo.dir, ["rev-parse", "agent/T-123"]);
    expect(stamp(base)).toEqual({ rewritten: 0 });
    expect(body("agent/T-123").match(/^Spec: S-12$/gm)).toHaveLength(1);
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123"])).toBe(once); // nothing changed, nothing rewritten
  });

  it("only takes our own id formats, because they end up in a commit message", () => {
    const base = agentBranch();
    expect(() =>
      stamp(base, { ids: { ...ids, ticket: "T-1\nSigned-off-by: someone" } }),
    ).toThrow(/not a ticket id/);
    expect(() => stamp(base, { ids: { ...ids, spec: "T-1" } })).toThrow(
      /not a spec id/,
    );
  });

  it("reports a before that does not exist and leaves the branch as it was", () => {
    agentBranch();
    const tip = gitOut(repo.dir, ["rev-parse", "agent/T-123"]);
    const result = stamp("deadbeef");
    expect(result.rewritten).toBe(0);
    expect(result.error).toMatch(/rev-list failed/);
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123"])).toBe(tip);
  });
});

describe("a branch that took in the integration branch (merge-fix)", () => {
  // main moved on; the ticket's branch merged it and settled a conflict in the merge commit
  function mergedBranch() {
    repo = makeRepo({ "shared.txt": "base\n" });
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-123"]);
    repo.commit({ "shared.txt": "ticket\n" }, "ticket work");
    const before = gitOut(repo.dir, ["rev-parse", "HEAD"]);
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    repo.commit({ "shared.txt": "other ticket\n" }, "another ticket merged");
    repo.commit({ "extra.txt": "e\n" }, "and more");
    const integrationTip = gitOut(repo.dir, ["rev-parse", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "agent/T-123"]);
    git(repo.dir, ["merge", "--no-edit", "spec/s"]); // conflicts
    repo.commit(
      { "shared.txt": "settled by the agent\n" },
      "merge spec/s, settle shared.txt",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    return { before, integrationTip };
  }

  it("stamps the merge commit and keeps the agent's conflict resolution in it", () => {
    const { before, integrationTip } = mergedBranch();
    const treeBefore = gitOut(repo.dir, ["rev-parse", "agent/T-123^{tree}"]);
    const result = stamp(before, { exclude: "spec/s" });
    expect(result).toEqual({ rewritten: 1 });
    expect(gitOut(repo.dir, ["rev-parse", "agent/T-123^{tree}"])).toBe(
      treeBefore,
    );
    expect(gitOut(repo.dir, ["show", "agent/T-123:shared.txt"])).toBe(
      "settled by the agent",
    );
    expect(body("agent/T-123")).toContain("Ticket: T-123");
    // still a merge of the ticket's line and the integration branch
    const parents = gitOut(repo.dir, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "agent/T-123",
    ])
      .split(" ")
      .slice(1);
    expect(parents).toEqual([before, integrationTip]);
  });

  it("leaves the integration branch's own commits exactly as they are", () => {
    const { before, integrationTip } = mergedBranch();
    stamp(before, { exclude: "spec/s" });
    expect(gitOut(repo.dir, ["rev-parse", "spec/s"])).toBe(integrationTip);
    expect(
      git(repo.dir, ["merge-base", "--is-ancestor", "spec/s", "agent/T-123"])
        .code,
    ).toBe(0);
    expect(body("spec/s")).not.toContain("Ticket:");
    expect(body("spec/s~1")).not.toContain("Ticket:");
  });
});
