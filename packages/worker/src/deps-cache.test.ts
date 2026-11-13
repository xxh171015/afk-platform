import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { depsCacheDirOf } from "./deps-cache.ts";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A slot's clone, made the way the slots make it: from the worker's main clone of the repo.
function slotClone(mainClone: string) {
  const dir = join(tempDir("afk-slot-"), "backend");
  gitOrThrow(tempDir("afk-cwd-"), ["clone", "--quiet", mainClone, dir]);
  return dir;
}

describe("the gate's dependency cache folder", () => {
  it("is the same for every slot of one repo, and different for a repo of the same name on another host", async () => {
    const github = makeRepo({ "a.txt": "github\n" });
    const gitlab = makeRepo({ "a.txt": "gitlab\n" });
    cleanups.push(
      () => github.cleanup(),
      () => gitlab.cleanup(),
    );
    const repos = new RepoStore(tempDir("afk-repos-"));
    const githubMain = await repos.ensure("backend", github.dir, "main");
    const gitlabMain = await repos.ensure("backend", gitlab.dir, "main");
    const root = tempDir("afk-cache-");

    const first = depsCacheDirOf(root, slotClone(githubMain));
    expect(depsCacheDirOf(root, slotClone(githubMain))).toBe(first);
    expect(depsCacheDirOf(root, slotClone(gitlabMain))).not.toBe(first);
    expect(first.startsWith(`${root}/`)).toBe(true);
  });
});
