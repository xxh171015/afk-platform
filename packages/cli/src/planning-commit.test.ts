import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPlanningCommit } from "./planning-commit.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const backend = {
  name: "backend",
  url: "https://github.com/acme/backend.git",
  defaultBranch: "main",
};

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: undefined },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr ?? result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function write(cwd: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
}

function initWork(
  files: Record<string, string> = { "README.md": "r\n" },
): string {
  const dir = join(tmp("afk-plan-"), "work");
  mkdirSync(dir);
  git(dir, ["init", "--quiet", "--initial-branch", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
}

function pushOrigin(work: string): string {
  const bare = join(dirname(work), "origin.git");
  git(dirname(work), ["clone", "--quiet", "--bare", work, bare]);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  return bare;
}

describe("inspectPlanningCommit", () => {
  it("skips a directory that is not a git repo", () => {
    expect(inspectPlanningCommit(tmp("afk-nongit-"), [backend])).toEqual({
      status: "skip",
    });
  });

  it("skips when origin is not a repo of this project", () => {
    const work = initWork();
    git(work, ["remote", "add", "origin", "https://github.com/acme/other.git"]);
    expect(inspectPlanningCommit(work, [backend])).toEqual({ status: "skip" });
  });

  it("accepts a pushed descendant of main with a clean planning tree", () => {
    const work = initWork({
      "README.md": "r\n",
      "GLOSSARY.md": "# terms\n",
      "AGENTS.md": "rules\n",
    });
    git(work, ["remote", "add", "origin", "git@github.com:acme/backend.git"]);
    // a real remote so --contains can see the push; URL still matches github
    const bare = join(dirname(work), "origin.git");
    git(dirname(work), ["clone", "--quiet", "--bare", work, bare]);
    git(work, ["remote", "remove", "origin"]);
    git(work, ["remote", "add", "origin", "git@github.com:acme/backend.git"]);
    git(work, ["remote", "set-url", "--push", "origin", bare]);
    git(work, ["push", "-q", "-u", "origin", "main"]);
    const sha = git(work, ["rev-parse", "HEAD"]);
    expect(inspectPlanningCommit(work, [backend])).toEqual({
      status: "ok",
      sha,
      repoName: "backend",
      dirty: false,
    });
  });

  it("rejects uncommitted GLOSSARY, ADR or AGENTS.md, and ignores other dirty files", () => {
    const work = initWork({
      "README.md": "r\n",
      "GLOSSARY.md": "# t\n",
      "AGENTS.md": "a\n",
      "docs/adr/0001.md": "# adr\n",
    });
    pushOrigin(work);
    const repos = [{ ...backend, url: join(dirname(work), "origin.git") }];
    const sha = git(work, ["rev-parse", "HEAD"]);

    write(work, { "src/app.ts": "x\n" });
    expect(inspectPlanningCommit(work, repos)).toMatchObject({
      status: "ok",
      sha,
      dirty: false,
    });

    write(work, { "GLOSSARY.md": "# dirty\n" });
    expect(inspectPlanningCommit(work, repos)).toMatchObject({
      status: "reject",
      reason: "dirty",
      sha,
      dirty: true,
    });
    git(work, ["checkout", "--", "GLOSSARY.md"]);

    write(work, { "docs/adr/0002.md": "# new\n" });
    expect(inspectPlanningCommit(work, repos).status).toBe("reject");
    git(work, ["clean", "-f", "docs/adr/0002.md"]);

    write(work, { "AGENTS.md": "changed\n" });
    expect(inspectPlanningCommit(work, repos)).toMatchObject({
      reason: "dirty",
      dirty: true,
    });
  });

  it("rejects a commit that has not been pushed", () => {
    const work = initWork({ "GLOSSARY.md": "# t\n" });
    pushOrigin(work);
    write(work, { "GLOSSARY.md": "# v2\n" });
    git(work, ["add", "GLOSSARY.md"]);
    git(work, ["commit", "--quiet", "-m", "local only"]);
    const repos = [{ ...backend, url: join(dirname(work), "origin.git") }];
    expect(inspectPlanningCommit(work, repos)).toMatchObject({
      status: "reject",
      reason: "not-pushed",
    });
  });

  it("rejects a commit that is not a descendant of the default branch", () => {
    const work = initWork();
    pushOrigin(work);
    git(work, ["checkout", "--orphan", "other"]);
    git(work, ["commit", "--quiet", "--allow-empty", "-m", "orphan"]);
    git(work, ["push", "-q", "-u", "origin", "other"]);
    const repos = [{ ...backend, url: join(dirname(work), "origin.git") }];
    expect(inspectPlanningCommit(work, repos)).toMatchObject({
      status: "reject",
      reason: "not-descendant",
    });
  });
});
