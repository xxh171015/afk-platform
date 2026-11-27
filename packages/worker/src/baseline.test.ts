import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import {
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runBaselineGate } from "./baseline.ts";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const junit = Buffer.from(
  '<testsuites tests="3"><testsuite name="a" tests="3" skipped="0"/></testsuites>',
).toString("base64");
const writesJunit = `mkdir -p reports && echo ${junit} | base64 -d > reports/junit.xml`;

function origin(): TestRepo {
  const repo = makeRepo({ "README.md": "r\n" });
  cleanups.push(() => repo.cleanup());
  repo.commit(
    {
      ".sandcastle/gates.yaml": `setup: "true"\ncommands:\n  - { name: test, run: ${JSON.stringify(writesJunit)}, timeoutSeconds: 30, junit: reports/junit.xml }\n`,
    },
    "gates",
  );
  return repo;
}

describe("running a baseline gate on a cut SHA", () => {
  it("passes when the cut's gate commands pass, and stores gate facts for reuse", async () => {
    const repo = origin();
    const sha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-baseline-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const result = await runBaselineGate(
      {
        repos: new RepoStore(root),
        makeGateSandbox: (dir) => new FakeGateSandbox(dir),
      },
      {
        repo: { name: "backend", url: repo.dir, defaultBranch: "main" },
        sha,
        specId: 1,
      },
      () => {},
    );
    expect(result).toMatchObject({
      stage: "baseline-gate",
      pass: true,
      reasons: [],
      tests: 3,
    });
    expect(result.gate?.commitSha).toBe(sha);
    expect(result.gate?.treeSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("opens the gate sandbox next to the stored clone so the container can follow gitdir", async () => {
    const repo = origin();
    const sha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let sandboxDir = "";
    await runBaselineGate(
      {
        repos: new RepoStore(root),
        makeGateSandbox: (dir) => {
          sandboxDir = dir;
          return new FakeGateSandbox(dir);
        },
      },
      {
        repo: { name: "backend", url: repo.dir, defaultBranch: "main" },
        sha,
        specId: 1,
      },
      () => {},
    );
    expect(sandboxDir.startsWith(root)).toBe(true);
  });
});
