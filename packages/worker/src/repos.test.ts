import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the worker's bare clones", () => {
  it("does not fetch a second backend from the first origin that already used the name", () => {
    const github = makeRepo({ "src/a.ts": "from-github\n" });
    const gitlab = makeRepo({ "src/a.ts": "from-gitlab\n" });
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => github.cleanup(),
      () => gitlab.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);

    const githubDir = repos.ensure("backend", github.dir, "main");
    const gitlabDir = repos.ensure("backend", gitlab.dir, "main");

    expect(githubDir).not.toBe(gitlabDir);
    expect(gitOrThrow(githubDir, ["show", "main:src/a.ts"]).trim()).toBe(
      "from-github",
    );
    expect(gitOrThrow(gitlabDir, ["show", "main:src/a.ts"]).trim()).toBe(
      "from-gitlab",
    );
  });
});
