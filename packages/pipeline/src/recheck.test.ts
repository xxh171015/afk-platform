import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitOrThrow } from "./exec.ts";
import { isConfigPath, isTestPath, recheckHit } from "./recheck.ts";
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
