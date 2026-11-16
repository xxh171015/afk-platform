import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPTS } from "./agent.ts";
import { git, gitOrThrow } from "./exec.ts";
import {
  autoMergeCommit,
  isConfigPath,
  isTestPath,
  recheckHit,
} from "./recheck.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe("isTestPath", () => {
  it("names common test files and directories, not sources", () => {
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("src/a.spec.tsx")).toBe(true);
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("src/__tests__/a.ts")).toBe(true);
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("src/a.ts")).toBe(false);
    expect(isTestPath("src/testing/helpers.ts")).toBe(false);
  });
});

describe("isConfigPath", () => {
  it("matches the default test and build configs, and extra gates.yaml paths", () => {
    expect(isConfigPath("vitest.config.ts")).toBe(true);
    expect(isConfigPath(".sandcastle/gates.yaml")).toBe(true);
    expect(isConfigPath(".github/workflows/ci.yml")).toBe(true);
    expect(isConfigPath("src/a.ts")).toBe(false);
    expect(isConfigPath("ci/timeout.yaml", ["ci/timeout.yaml"])).toBe(true);
    expect(isConfigPath("ci/timeout.yaml")).toBe(false);
  });
});

describe("recheckHit", () => {
  it("hits when an existing test assertion changes", () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const from = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const to = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "flip assertion",
    );
    expect(recheckHit({ repoDir: repo.dir, fromSha: from, toSha: to })).toEqual(
      {
        hit: true,
        paths: ["src/a.test.ts"],
        fromSha: from,
        toSha: to,
      },
    );
  });

  it("does not hit when only source files change, or when only new tests are added", () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const from = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const sourceOnly = repo.commit(
      { "src/a.ts": "export const n = 2;\n" },
      "source",
    );
    expect(
      recheckHit({ repoDir: repo.dir, fromSha: from, toSha: sourceOnly }),
    ).toEqual({
      hit: false,
      paths: [],
      fromSha: from,
      toSha: sourceOnly,
    });
    const added = repo.commit(
      {
        "src/a.test.ts":
          'it("is 1", () => expect(n).toBe(1));\nit("still 1", () => expect(n).toBe(1));\n',
        "src/b.test.ts": 'it("new", () => expect(true).toBe(true));\n',
      },
      "new tests",
    );
    expect(
      recheckHit({ repoDir: repo.dir, fromSha: sourceOnly, toSha: added }),
    ).toEqual({
      hit: false,
      paths: [],
      fromSha: sourceOnly,
      toSha: added,
    });
  });

  it("hits when a test config changes, including an extra path from gates.yaml", () => {
    repo = makeRepo({
      "vitest.config.ts": "export default { testTimeout: 5000 };\n",
      "ci/timeout.yaml": "timeout: 10\n",
    });
    const from = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const to = repo.commit(
      {
        "vitest.config.ts": "export default { testTimeout: 60000 };\n",
        "ci/timeout.yaml": "timeout: 60\n",
      },
      "timeouts",
    );
    const withoutExtra = recheckHit({
      repoDir: repo.dir,
      fromSha: from,
      toSha: to,
    });
    expect(withoutExtra).toEqual({
      hit: true,
      paths: ["vitest.config.ts"],
      fromSha: from,
      toSha: to,
    });
    const withExtra = recheckHit({
      repoDir: repo.dir,
      fromSha: from,
      toSha: to,
      extraConfigPaths: ["ci/timeout.yaml"],
    });
    expect(withExtra.hit).toBe(true);
    expect(withExtra.paths.sort()).toEqual([
      "ci/timeout.yaml",
      "vitest.config.ts",
    ]);
  });

  it("does not hit a test this ticket added, only tests that existed at the baseline", () => {
    repo = makeRepo({ "src/a.ts": "export const n = 1;\n" });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const afterImplement = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n' },
      "add tests",
    );
    const afterFix = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "flip assertion",
    );
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha: afterImplement,
        toSha: afterFix,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: false,
      paths: [],
      fromSha: afterImplement,
      toSha: afterFix,
    });
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha: afterImplement,
        toSha: afterFix,
      }),
    ).toMatchObject({ hit: true, paths: ["src/a.test.ts"] });
  });

  it("hits when an existing test file is deleted", () => {
    repo = makeRepo({ "src/a.test.ts": "it('x', () => {});\n" });
    const from = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    rmSync(join(repo.dir, "src/a.test.ts"));
    const to = repo.commit({ "src/keep.ts": "1\n" }, "delete test");
    expect(
      recheckHit({ repoDir: repo.dir, fromSha: from, toSha: to }),
    ).toMatchObject({ hit: true, paths: ["src/a.test.ts"] });
  });
});

describe("recheckHit from an auto-merge commit", () => {
  it("does not hit when update-branch auto-merges main's test assertion and the agent leaves it", () => {
    repo = makeRepo({
      "src/a.ts": "export const n = 1;\n",
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    const ours = repo.commit(
      { "src/feature.ts": "export const f = 1;\n" },
      "spec",
    );
    gitOrThrow(repo.dir, ["checkout", "--quiet", "main"]);
    const theirs = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "main flips assertion",
    );
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-1",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    gitOrThrow(repo.dir, ["merge", "--no-edit", "main"]);
    const toSha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: false,
      paths: [],
      fromSha,
      toSha,
    });
  });

  it("hits when the agent drops main's test lines while resolving a conflict", () => {
    repo = makeRepo({
      "src/a.test.ts": 'it("shared", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    const ours = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(1));\nit("spec", () => expect(true).toBe(true));\n',
      },
      "spec adds a test",
    );
    gitOrThrow(repo.dir, ["checkout", "--quiet", "main"]);
    const theirs = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(2));\nit("main", () => expect(true).toBe(true));\n',
      },
      "main flips assertion",
    );
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-2",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    git(repo.dir, ["merge", "--no-edit", "main"]);
    const resolved =
      'it("shared", () => expect(n).toBe(1));\nit("spec", () => expect(true).toBe(true));\n';
    const toSha = repo.commit({ "src/a.test.ts": resolved }, "keep spec side");
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha,
      toSha,
    });
  });

  it("hits when the agent edits an existing spec-side test after a clean auto-merge", () => {
    repo = makeRepo({
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    const ours = repo.commit(
      { "src/feature.ts": "export const f = 1;\n" },
      "spec",
    );
    gitOrThrow(repo.dir, ["checkout", "--quiet", "main"]);
    const theirs = repo.commit({ "src/from-main.ts": "1\n" }, "main moves");
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-3",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    gitOrThrow(repo.dir, ["merge", "--no-edit", "main"]);
    const toSha = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(9));\n' },
      "agent flips spec test",
    );
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha,
      toSha,
    });
  });

  it("merge-fix: does not hit when the integration branch's test assertion auto-merges and the agent leaves it", () => {
    repo = makeRepo({
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    const ours = repo.commit({ "src/ticket.ts": "1\n" }, "ticket work");
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    const theirs = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(2));\n' },
      "integration flips assertion",
    );
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-4",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "agent/T-1"]);
    gitOrThrow(repo.dir, ["merge", "--no-edit", "spec/s"]);
    const toSha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: false,
      paths: [],
      fromSha,
      toSha,
    });
  });

  it("merge-fix: hits when the agent drops the integration branch's test lines in a conflict", () => {
    repo = makeRepo({
      "src/a.test.ts": 'it("shared", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    const ours = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(1));\nit("ticket", () => expect(true).toBe(true));\n',
      },
      "ticket adds a test",
    );
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    const theirs = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(2));\nit("integration", () => expect(true).toBe(true));\n',
      },
      "integration flips assertion",
    );
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-5",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "agent/T-1"]);
    git(repo.dir, ["merge", "--no-edit", "spec/s"]);
    const toSha = repo.commit(
      {
        "src/a.test.ts":
          'it("shared", () => expect(n).toBe(1));\nit("ticket", () => expect(true).toBe(true));\n',
      },
      "keep ticket side",
    );
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha,
      toSha,
    });
  });

  it("merge-fix: hits when the agent edits an existing ticket-side test after a clean auto-merge", () => {
    repo = makeRepo({
      "src/a.test.ts": 'it("is 1", () => expect(n).toBe(1));\n',
    });
    const baseline = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    const ours = repo.commit({ "src/ticket.ts": "1\n" }, "ticket work");
    gitOrThrow(repo.dir, ["checkout", "--quiet", "spec/s"]);
    const theirs = repo.commit(
      { "src/from-int.ts": "1\n" },
      "integration moves",
    );
    const fromSha = autoMergeCommit({
      repoDir: repo.dir,
      oursSha: ours,
      theirsSha: theirs,
      ref: "refs/afk/recheck/R-6",
    });
    gitOrThrow(repo.dir, ["checkout", "--quiet", "agent/T-1"]);
    gitOrThrow(repo.dir, ["merge", "--no-edit", "spec/s"]);
    const toSha = repo.commit(
      { "src/a.test.ts": 'it("is 1", () => expect(n).toBe(9));\n' },
      "agent flips ticket test",
    );
    expect(
      recheckHit({
        repoDir: repo.dir,
        fromSha,
        toSha,
        baselineSha: baseline,
      }),
    ).toEqual({
      hit: true,
      paths: ["src/a.test.ts"],
      fromSha,
      toSha,
    });
  });
});

describe("recheck prompt", () => {
  it("tells Recheck that update-branch and merge-fix fromSha is the auto-merge", () => {
    const text = readFileSync(PROMPTS.recheck, "utf8");
    expect(text).toContain("自动合并结果");
    expect(text).toContain("update-branch");
    expect(text).toContain("merge-fix");
    expect(text).toContain("git diff");
  });
});
