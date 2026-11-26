import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the worker's bare clones", () => {
  it("clones and fetches once at a time when several jobs want the same repo at once", async () => {
    const origin = makeRepo({ "src/a.ts": "a\n" });
    gitOrThrow(origin.dir, ["branch", "agent/T-1"]);
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => origin.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);

    const dirs = await Promise.all(
      [1, 2, 3, 4].map(() => repos.ensure("backend", origin.dir, "main")),
    );

    expect(new Set(dirs).size).toBe(1);
    expect(readdirSync(root)).toEqual([basename(dirs[0] as string)]);
    expect(repos.has(dirs[0] as string, "refs/afk/origin/agent/T-1")).toBe(
      true,
    );
  });

  it("does not fetch a second backend from the first origin that already used the name", async () => {
    const github = makeRepo({ "src/a.ts": "from-github\n" });
    const gitlab = makeRepo({ "src/a.ts": "from-gitlab\n" });
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => github.cleanup(),
      () => gitlab.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);

    const githubDir = await repos.ensure("backend", github.dir, "main");
    const gitlabDir = await repos.ensure("backend", gitlab.dir, "main");

    expect(githubDir).not.toBe(gitlabDir);
    expect(gitOrThrow(githubDir, ["show", "main:src/a.ts"]).trim()).toBe(
      "from-github",
    );
    expect(gitOrThrow(gitlabDir, ["show", "main:src/a.ts"]).trim()).toBe(
      "from-gitlab",
    );
  });

  it("fetches a ticket branch origin moved into an origin-tracking ref, and leaves the local head as it is", async () => {
    const origin = makeRepo();
    gitOrThrow(origin.dir, ["checkout", "-b", "agent/T-1"]);
    gitOrThrow(origin.dir, ["commit", "--allow-empty", "-m", "first"]);
    const first = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => origin.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);
    const dir = await repos.ensure("backend", origin.dir, "main");
    gitOrThrow(dir, ["update-ref", "refs/heads/agent/T-1", first]);

    gitOrThrow(origin.dir, ["commit", "--allow-empty", "-m", "moved"]);
    const moved = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    await repos.ensure("backend", origin.dir, "main");

    expect(gitOrThrow(dir, ["rev-parse", "refs/heads/agent/T-1"])).toBe(first);
    expect(gitOrThrow(dir, ["rev-parse", "refs/afk/origin/agent/T-1"])).toBe(
      moved,
    );
    expect(repos.findByUrl(origin.dir)).toBe(dir);
    expect(repos.findByUrl("/no/such/origin")).toBeUndefined();
  });
});

describe("fetchObject", () => {
  it("fetches a commit that lives only on a branch ensure does not follow", async () => {
    const origin = makeRepo({ "src/a.ts": "a\n" });
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => origin.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);
    const dir = await repos.ensure("backend", origin.dir, "main");
    gitOrThrow(origin.dir, ["checkout", "--quiet", "-b", "topic"]);
    const sha = origin.commit({ "src/a.ts": "topic\n" }, "on topic");
    expect(repos.hasObject(dir, sha)).toBe(false);

    await repos.fetchObject(dir, origin.dir, sha);

    expect(repos.hasObject(dir, sha)).toBe(true);
  });

  it("fetches a blob by SHA and does not call a missing object a planning commit", async () => {
    const origin = makeRepo({ "src/a.ts": "a\n" });
    const root = mkdtempSync(join(tmpdir(), "afk-repos-"));
    cleanups.push(
      () => origin.cleanup(),
      () => rmSync(root, { recursive: true, force: true }),
    );
    const repos = new RepoStore(root);
    const dir = await repos.ensure("backend", origin.dir, "main");
    gitOrThrow(origin.dir, ["checkout", "--quiet", "-b", "topic"]);
    origin.commit({ "src/a.ts": "blob-side\n" }, "on topic");
    const blob = gitOrThrow(origin.dir, ["rev-parse", "HEAD:src/a.ts"]);

    await repos.fetchObject(dir, origin.dir, blob);
    expect(repos.hasObject(dir, blob)).toBe(true);

    await expect(
      repos.fetchObject(dir, origin.dir, "a".repeat(40)),
    ).rejects.toThrow(/object a{40} is not on origin/);
    await expect(
      repos.fetchObject(dir, origin.dir, "a".repeat(40)),
    ).rejects.not.toThrow(/planning commit/);
  });
});
