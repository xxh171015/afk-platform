import { afterEach, describe, expect, it } from "vitest";
import { git } from "./exec.ts";
import {
  changedFiles,
  checkProtectedPaths,
  globMatches,
} from "./protected-paths.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

describe("globMatches", () => {
  it.each([
    ["openapi/openapi.yaml", "openapi/openapi.yaml", true],
    ["openapi/openapi.yaml", "openapi/other.yaml", false],
    ["openapi/**", "openapi/openapi.yaml", true],
    ["openapi/**", "openapi/v2/spec/openapi.yaml", true],
    ["openapi/**", "src/openapi/x.yaml", false],
    [".github/", ".github/workflows/ci.yml", true], // a trailing slash means everything below
    [".github/", "x/.github/ci.yml", false],
    ["vitest.config.*", "vitest.config.ts", true],
    ["vitest.config.*", "packages/a/vitest.config.ts", false], // not recursive without **
    ["**/vitest.config.*", "packages/a/vitest.config.ts", true],
    ["**/vitest.config.*", "vitest.config.ts", true],
    ["tsconfig.json", "tsconfig.json", true],
    ["tsconfig.json", "tsconfig.json.bak", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["a.b", "axb", false], // dots are literal
  ])("%s vs %s -> %s", (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });
});

describe("checkProtectedPaths", () => {
  const protectedPaths = ["openapi/**", ".github/", "tsconfig.json"];

  it("is clean when no protected path was touched", () => {
    const check = checkProtectedPaths({
      changed: ["src/a.ts"],
      protectedPaths,
      approved: [],
    });
    expect(check).toEqual({
      changed: ["src/a.ts"],
      touched: [],
      unapproved: [],
    });
  });

  it("reports protected paths that were touched and not approved", () => {
    const check = checkProtectedPaths({
      changed: ["src/a.ts", "openapi/openapi.yaml", ".github/workflows/ci.yml"],
      protectedPaths,
      approved: [],
    });
    expect(check.touched).toEqual([
      "openapi/openapi.yaml",
      ".github/workflows/ci.yml",
    ]);
    expect(check.unapproved).toEqual(check.touched);
  });

  it("subtracts the approved paths: only what is left counts", () => {
    const check = checkProtectedPaths({
      changed: ["openapi/openapi.yaml", "tsconfig.json"],
      protectedPaths,
      approved: ["openapi/openapi.yaml"],
    });
    expect(check.touched).toEqual(["openapi/openapi.yaml", "tsconfig.json"]);
    expect(check.unapproved).toEqual(["tsconfig.json"]);
  });

  it("is not a violation when everything touched was approved", () => {
    const check = checkProtectedPaths({
      changed: ["openapi/openapi.yaml"],
      protectedPaths,
      approved: ["openapi/**"],
    });
    expect(check.unapproved).toEqual([]);
  });
});

describe("changedFiles", () => {
  let repo: TestRepo;
  afterEach(() => repo.cleanup());

  it("lists what the branch changed since it left the base, not what the base gained since", () => {
    repo = makeRepo({ "a.txt": "a\n" });
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    repo.commit({ "src/new.ts": "x\n", "a.txt": "changed\n" }, "agent work");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    repo.commit({ "main-only.txt": "m\n" }, "main moves on");
    expect(changedFiles(repo.dir, "main", "agent/T-1").sort()).toEqual([
      "a.txt",
      "src/new.ts",
    ]);
  });
});
