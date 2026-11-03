import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type PlanningTask, runPlanningCommit } from "./planning.ts";
import { pushRef } from "./push.ts";
import { RepoStore } from "./repos.ts";

// The planning commit (ADR 0005), against a real origin repo, the worker's real clone cache and real pushes.

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
  const repo = makeRepo({
    "GLOSSARY.md": "# Orders\n\nline 2\n\nline 3\n",
    "src/a.ts": "a\n",
  });
  cleanups.push(() => repo.cleanup());
  return repo;
}

// The patch a person's checkout would send: their edits to the planning docs against origin's main as it is now.
function patchFrom(repo: TestRepo, files: Record<string, string>): string {
  const work = join(tmp("afk-person-"), "work");
  gitOrThrow(tmpdir(), ["clone", "--quiet", repo.dir, work]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  gitOrThrow(work, ["add", "-A"]);
  return git(work, ["diff", "--cached", "--binary", "--full-index", "HEAD"])
    .stdout;
}

const task = (repo: TestRepo, patch: string | null): PlanningTask => ({
  spec: { id: 1, displayId: "S-1", title: "Bulk ship" },
  repo: { name: "backend", url: repo.dir, defaultBranch: "main" },
  integrationBranch: "spec/abc123/bulk-ship",
  patch,
  message: "Planning docs for S-1 Bulk ship\n\nSpec: S-1",
});

function run(repo: TestRepo, patch: string | null) {
  const repos = new RepoStore(tmp("afk-worker-repos-"));
  return {
    repos,
    result: runPlanningCommit(
      { repos, push: (request) => pushRef(request) },
      task(repo, patch),
      () => {},
    ),
  };
}

describe("the planning commit", () => {
  it("commits the patch onto the default branch's head as the platform, and pushes it as the integration branch", () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, sharpened\n\nline 3\n",
      "docs/adr/0002-bulk.md": "# Bulk\n",
    });
    const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);

    const { result } = run(repo, patch);

    expect(result.outcome).toBe("committed");
    const sha = (result as { sha: string }).sha;
    expect(gitOrThrow(repo.dir, ["rev-parse", "spec/abc123/bulk-ship"])).toBe(
      sha,
    );
    expect(gitOrThrow(repo.dir, ["rev-parse", `${sha}^`])).toBe(main);
    expect(gitOrThrow(repo.dir, ["show", `${sha}:GLOSSARY.md`])).toContain(
      "line 2, sharpened",
    );
    expect(gitOrThrow(repo.dir, ["show", `${sha}:docs/adr/0002-bulk.md`])).toBe(
      "# Bulk",
    );
    expect(gitOrThrow(repo.dir, ["log", "-1", "--format=%an%n%B", sha])).toBe(
      "afk-worker\nPlanning docs for S-1 Bulk ship\n\nSpec: S-1",
    );
  });

  it("merges the patch three ways with what reached the default branch after the person's base", () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, sharpened\n\nline 3\n",
    });
    repo.commit(
      { "GLOSSARY.md": "# Orders\n\nline 2\n\nline 3, theirs\n" },
      "theirs",
    );

    const { result } = run(repo, patch);

    expect(result.outcome).toBe("committed");
    const sha = (result as { sha: string }).sha;
    expect(gitOrThrow(repo.dir, ["show", `${sha}:GLOSSARY.md`])).toBe(
      "# Orders\n\nline 2, sharpened\n\nline 3, theirs",
    );
  });

  it("names the files that conflict, and pushes nothing", () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, mine\n\nline 3\n",
    });
    repo.commit(
      { "GLOSSARY.md": "# Orders\n\nline 2, theirs\n\nline 3\n" },
      "theirs",
    );

    const { result } = run(repo, patch);

    expect(result).toEqual({
      stage: "planning-commit",
      outcome: "conflict",
      files: ["GLOSSARY.md"],
    });
    expect(
      gitOrThrow(repo.dir, ["branch", "--list", "spec/abc123/bulk-ship"]),
    ).toBe("");
  });

  it("without a patch takes the default branch's head and makes no branch", () => {
    const repo = origin();
    const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);

    const { result } = run(repo, null);

    expect(result).toEqual({
      stage: "planning-commit",
      outcome: "unchanged",
      sha: main,
    });
    expect(
      gitOrThrow(repo.dir, ["branch", "--list", "spec/abc123/bulk-ship"]),
    ).toBe("");
  });

  it("run again after its push went through, gives the commit it made instead of failing", () => {
    const repo = origin();
    const patch = patchFrom(repo, { "docs/adr/0002-bulk.md": "# Bulk\n" });
    const first = run(repo, patch).result as { sha: string };

    const again = run(repo, patch).result;

    expect(again).toEqual({
      stage: "planning-commit",
      outcome: "committed",
      sha: first.sha,
    });
  });
});
