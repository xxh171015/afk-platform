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
afterEach(async () => {
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

async function run(repo: TestRepo, patch: string | null) {
  const repos = new RepoStore(tmp("afk-worker-repos-"));
  return {
    repos,
    result: await runPlanningCommit(
      { repos, push: (request) => pushRef(request) },
      task(repo, patch),
      () => {},
    ),
  };
}

describe("the planning commit", () => {
  it("commits the patch onto the default branch's head as the platform, and pushes it as the integration branch", async () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, sharpened\n\nline 3\n",
      "docs/adr/0002-bulk.md": "# Bulk\n",
    });
    const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);

    const { result } = await run(repo, patch);

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

  it("merges the patch three ways with what reached the default branch after the person's base", async () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, sharpened\n\nline 3\n",
    });
    repo.commit(
      { "GLOSSARY.md": "# Orders\n\nline 2\n\nline 3, theirs\n" },
      "theirs",
    );

    const { result } = await run(repo, patch);

    expect(result.outcome).toBe("committed");
    const sha = (result as { sha: string }).sha;
    expect(gitOrThrow(repo.dir, ["show", `${sha}:GLOSSARY.md`])).toBe(
      "# Orders\n\nline 2, sharpened\n\nline 3, theirs",
    );
  });

  it("names the files that conflict, and pushes nothing", async () => {
    const repo = origin();
    const patch = patchFrom(repo, {
      "GLOSSARY.md": "# Orders\n\nline 2, mine\n\nline 3\n",
    });
    repo.commit(
      { "GLOSSARY.md": "# Orders\n\nline 2, theirs\n\nline 3\n" },
      "theirs",
    );

    const { result } = await run(repo, patch);

    expect(result).toEqual({
      stage: "planning-commit",
      outcome: "conflict",
      files: ["GLOSSARY.md"],
    });
    expect(
      gitOrThrow(repo.dir, ["branch", "--list", "spec/abc123/bulk-ship"]),
    ).toBe("");
  });

  it("without a patch takes the default branch's head and makes no branch", async () => {
    const repo = origin();
    const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);

    const { result } = await run(repo, null);

    expect(result).toEqual({
      stage: "planning-commit",
      outcome: "unchanged",
      sha: main,
    });
    expect(
      gitOrThrow(repo.dir, ["branch", "--list", "spec/abc123/bulk-ship"]),
    ).toBe("");
  });

  it("run again after its push went through, gives the commit it made instead of failing", async () => {
    const repo = origin();
    const patch = patchFrom(repo, { "docs/adr/0002-bulk.md": "# Bulk\n" });
    const first = (await run(repo, patch)).result as { sha: string };

    const again = (await run(repo, patch)).result;

    expect(again).toEqual({
      stage: "planning-commit",
      outcome: "committed",
      sha: first.sha,
    });
  });

  describe("with an afk/setup branch on origin", () => {
    function pushSetup(repo: TestRepo, files: Record<string, string>): string {
      gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "afk/setup"]);
      const sha = repo.commit(files, "Set up for the AFK platform");
      gitOrThrow(repo.dir, ["checkout", "--quiet", "main"]);
      return sha;
    }

    it("commits the planning docs on top of the setup commit", async () => {
      const repo = origin();
      const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);
      const setup = pushSetup(repo, {
        ".sandcastle/gates.yaml": "steps: []\n",
        "AGENTS.md": "# Backend\n",
      });
      const patch = patchFrom(repo, { "docs/adr/0002-bulk.md": "# Bulk\n" });

      const { result } = await run(repo, patch);

      expect(result.outcome).toBe("committed");
      const sha = (result as { sha: string }).sha;
      const setupCommit = gitOrThrow(repo.dir, ["rev-parse", `${sha}^`]);
      expect(
        gitOrThrow(repo.dir, ["log", "-1", "--format=%P", setupCommit]),
      ).toBe(`${main} ${setup}`);
      expect(
        gitOrThrow(repo.dir, ["show", `${sha}:.sandcastle/gates.yaml`]),
      ).toBe("steps: []");
      expect(
        gitOrThrow(repo.dir, ["show", `${sha}:docs/adr/0002-bulk.md`]),
      ).toBe("# Bulk");
    });

    it("takes planning docs written in the afk/setup worktree: their AGENTS.md is the setup's, sharpened", async () => {
      const repo = origin();
      pushSetup(repo, { "AGENTS.md": "# Backend\n\nline 2\n" });
      // the person planned on afk/setup; plat takes the patch against afk/setup as origin has it
      const work = join(tmp("afk-person-"), "work");
      gitOrThrow(tmpdir(), [
        "clone",
        "--quiet",
        "-b",
        "afk/setup",
        repo.dir,
        work,
      ]);
      writeFileSync(
        join(work, "AGENTS.md"),
        "# Backend\n\nline 2, sharpened\n",
      );
      gitOrThrow(work, ["add", "-A"]);
      const patch = git(work, [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "origin/afk/setup",
        "--",
        "AGENTS.md",
      ]).stdout;

      const { result } = await run(repo, patch);

      expect(result.outcome).toBe("committed");
      const sha = (result as { sha: string }).sha;
      expect(gitOrThrow(repo.dir, ["show", `${sha}:AGENTS.md`])).toBe(
        "# Backend\n\nline 2, sharpened",
      );
    });

    it("without a patch pushes the setup commit as the integration branch", async () => {
      const repo = origin();
      const main = gitOrThrow(repo.dir, ["rev-parse", "main"]);
      pushSetup(repo, { ".sandcastle/gates.yaml": "steps: []\n" });

      const { result } = await run(repo, null);

      expect(result.outcome).toBe("committed");
      const sha = (result as { sha: string }).sha;
      expect(gitOrThrow(repo.dir, ["rev-parse", "spec/abc123/bulk-ship"])).toBe(
        sha,
      );
      expect(gitOrThrow(repo.dir, ["rev-parse", `${sha}^1`])).toBe(main);

      expect((await run(repo, null)).result).toEqual(result);
    });
  });
});
