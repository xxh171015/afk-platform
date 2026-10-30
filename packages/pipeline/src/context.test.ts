import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readContract, renderContext } from "./context.ts";
import { bundleFor } from "./fixtures.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

const dirs: string[] = [];
let repo: TestRepo | undefined;
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  repo?.cleanup();
  repo = undefined;
});
const ctxDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-ctx-"));
  dirs.push(dir);
  return join(dir, "context");
};
const read = (dir: string, file: string) =>
  readFileSync(join(dir, file), "utf8");
const run = { runId: "R-9", baseSha: "abc123", branch: "agent/T-123" };

describe("renderContext", () => {
  it("writes ticket.md, spec.md and run.json", () => {
    const dir = ctxDir();
    renderContext({ dir, bundle: bundleFor(), run });
    expect(read(dir, "ticket.md")).toContain("# T-123 Export orders as CSV");
    expect(read(dir, "ticket.md")).toContain("- returns text/csv");
    expect(read(dir, "ticket.md")).toContain("- src/orders/**");
    expect(read(dir, "ticket.md")).toContain("Add GET /orders/export.");
    expect(read(dir, "spec.md")).toContain("# S-12 Order export");
    expect(read(dir, "spec.md")).toContain("Customers want CSV.");
    expect(JSON.parse(read(dir, "run.json"))).toEqual({
      stage: "implement",
      runId: "R-9",
      ticket: "T-123",
      spec: "S-12",
      baseSha: "abc123",
      branch: "agent/T-123",
      integrationBranch: "spec/order-export",
      allowedProtectedPaths: [],
      fixCounts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
      contract: null,
    });
  });

  it("puts the approved protected paths and the stage in run.json", () => {
    const dir = ctxDir();
    renderContext({
      dir,
      bundle: bundleFor({
        stage: "gate-fix",
        allowedProtectedPaths: ["openapi/openapi.yaml"],
      }),
      run,
    });
    const runJson = JSON.parse(read(dir, "run.json"));
    expect(runJson.stage).toBe("gate-fix");
    expect(runJson.allowedProtectedPaths).toEqual(["openapi/openapi.yaml"]);
  });

  it("writes the failure log for a fix and the review result for a review-fix", () => {
    const dir = ctxDir();
    const review = {
      verdict: "fix",
      mustFix: [{ file: "a.ts", problem: "null check" }],
    };
    renderContext({
      dir,
      bundle: bundleFor({ stage: "review-fix" }),
      run,
      failureLog: "boom\n",
      review,
    });
    expect(read(dir, "failure/gate.log")).toBe("boom\n");
    expect(JSON.parse(read(dir, "review.json"))).toEqual(review);
  });

  it("writes neither when there is nothing to show", () => {
    const dir = ctxDir();
    renderContext({ dir, bundle: bundleFor(), run });
    expect(existsSync(join(dir, "failure"))).toBe(false);
    expect(existsSync(join(dir, "review.json"))).toBe(false);
    expect(existsSync(join(dir, "contract"))).toBe(false);
  });

  it("writes the contract file under contract/ and points run.json at it", () => {
    const dir = ctxDir();
    const bundle = bundleFor({
      contract: {
        sha: "c0ffee",
        path: "backend:openapi/openapi.yaml",
        repoId: 1,
      },
    });
    renderContext({
      dir,
      bundle,
      run,
      contract: { path: "openapi/openapi.yaml", content: "openapi: 3.1.0\n" },
    });
    expect(read(dir, "contract/openapi.yaml")).toBe("openapi: 3.1.0\n");
    expect(JSON.parse(read(dir, "run.json")).contract).toEqual({
      sha: "c0ffee",
      file: "contract/openapi.yaml",
    });
  });
});

describe("readContract", () => {
  it("reads the contract file as it was at the recorded SHA, not as it is now", () => {
    repo = makeRepo({ "openapi/openapi.yaml": "version: 1\n" });
    const sha = repo.commit(
      { "openapi/openapi.yaml": "version: 2\n" },
      "contract ticket merged",
    );
    repo.commit(
      { "openapi/openapi.yaml": "version: 3\n" },
      "someone changed it later",
    );
    const contract = readContract(repo.dir, {
      sha,
      path: "backend:openapi/openapi.yaml",
      repoId: 1,
    });
    expect(contract).toEqual({
      path: "openapi/openapi.yaml",
      content: "version: 2\n",
    });
  });

  it("fails loudly when the file is not at that SHA", () => {
    repo = makeRepo();
    const sha = repo.commit({ "a.txt": "x\n" }, "c");
    expect(() =>
      readContract(repo?.dir as string, {
        sha,
        path: "backend:openapi/openapi.yaml",
        repoId: 1,
      }),
    ).toThrow(/git show/);
  });
});
