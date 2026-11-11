import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenRequest, TokenSource } from "@afk/host";
import { gitOut } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCredentials } from "./credentials.ts";
import type { ExecutorDeps } from "./executor.ts";
import type { GitToken, PushFn } from "./push.ts";
import { RepoStore } from "./repos.ts";

let counter: number;
let asked: TokenRequest[];
const tokens: TokenSource = {
  async tokenFor(request) {
    asked.push(request);
    counter += 1;
    return `token-${counter}`;
  },
};
let seed: TestRepo;
let root: string;
beforeEach(() => {
  counter = 0;
  asked = [];
  seed = makeRepo({ "README.md": "# x\n" });
  root = mkdtempSync(join(tmpdir(), "afk-creds-"));
});
afterEach(() => {
  seed.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function deps(over: Partial<ExecutorDeps> = {}) {
  const pushed: (GitToken | undefined)[] = [];
  const push: PushFn = (_request, token) => {
    pushed.push(token);
    return { ok: true };
  };
  const base = {
    repos: new RepoStore(root),
    push,
    api: { prePush: async () => "held" as const },
    ...over,
  } as unknown as ExecutorDeps;
  return { base, pushed };
}
const ref = () => ({ owner: "me", name: "pilot" });
const request = {
  repoDir: ".",
  source: "refs/heads/spec/x",
  target: "refs/heads/spec/x",
  expectedOld: "",
};

describe("a stage's credentials", () => {
  it("are a token for this repo that can write contents, and nothing else", async () => {
    const { base } = deps({ credentials: { tokens, repoRef: ref } });
    await withCredentials(base, "https://github.com/me/pilot.git");
    expect(asked).toEqual([
      {
        repo: { owner: "me", name: "pilot" },
        permissions: { contents: "write" },
      },
    ]);
  });

  it("go with every push", async () => {
    const { base, pushed } = deps({ credentials: { tokens, repoRef: ref } });
    const bound = await withCredentials(base, "x");
    bound.push(request);
    expect(pushed).toEqual(["token-1"]);
  });

  it("go as oauth2 on a GitLab host", async () => {
    const { base, pushed } = deps({
      credentials: {
        tokens,
        repoRef: ref,
        gitUser: () => "oauth2",
      },
    });
    const bound = await withCredentials(
      base,
      "https://gitlab.example/me/pilot.git",
    );
    bound.push(request);
    expect(pushed).toEqual([{ user: "oauth2", token: "token-1" }]);
  });

  it("are renewed when the stage re-checks its lease before a push", async () => {
    const { base, pushed } = deps({ credentials: { tokens, repoRef: ref } });
    const bound = await withCredentials(base, "x");
    await bound.api.prePush({} as never);
    bound.push(request);
    expect(pushed).toEqual(["token-2"]);
  });

  it("are not renewed for a lease that is gone", async () => {
    const { base, pushed } = deps({
      credentials: { tokens, repoRef: ref },
      api: {
        prePush: async () => "lost" as const,
        gateResult: async () => undefined,
      },
    });
    const bound = await withCredentials(base, "x");
    expect(await bound.api.prePush({} as never)).toBe("lost");
    bound.push(request);
    expect(pushed).toEqual(["token-1"]);
  });

  it("leave a worker without them as it was", async () => {
    const { base } = deps();
    expect(await withCredentials(base, "x")).toBe(base);
  });
});

describe("the other repos a stage reads", () => {
  const byUrl = (url: string) => ({
    owner: "me",
    name: url.split("/").pop()?.replace(".git", "") ?? "",
  });
  const PILOT = "https://github.com/me/pilot.git";
  const BACKEND = "https://github.com/me/backend.git";
  const header = (store: RepoStore, url: string) =>
    (store as unknown as { env(url: string): Record<string, string> }).env(url)
      .GIT_CONFIG_VALUE_0;
  const basic = (token: string) =>
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  it("each get a token of their own that can only read contents", async () => {
    const { base } = deps({ credentials: { tokens, repoRef: byUrl } });
    await withCredentials(base, PILOT, [BACKEND]);
    expect(asked).toEqual([
      {
        repo: { owner: "me", name: "pilot" },
        permissions: { contents: "write" },
      },
      {
        repo: { owner: "me", name: "backend" },
        permissions: { contents: "read" },
      },
    ]);
  });

  it("are cloned and fetched with their own token, and the stage's repo with its own", async () => {
    const { base } = deps({ credentials: { tokens, repoRef: byUrl } });
    const bound = await withCredentials(base, PILOT, [BACKEND]);
    expect(header(bound.repos, PILOT)).toBe(basic("token-1"));
    expect(header(bound.repos, BACKEND)).toBe(basic("token-2"));
  });

  it("are asked for once when a repo is named twice, and never twice for the stage's own repo", async () => {
    const { base } = deps({ credentials: { tokens, repoRef: byUrl } });
    await withCredentials(base, PILOT, [BACKEND, BACKEND, PILOT]);
    expect(asked).toHaveLength(2);
  });

  it("are renewed with the stage's own when the stage re-checks its lease", async () => {
    const { base } = deps({ credentials: { tokens, repoRef: byUrl } });
    const bound = await withCredentials(base, PILOT, [BACKEND]);
    await bound.api.prePush({} as never);
    expect(header(bound.repos, PILOT)).toBe(basic("token-3"));
    expect(header(bound.repos, BACKEND)).toBe(basic("token-4"));
  });
});

describe("a clone reached with a token", () => {
  it("hands the token to git as a header in its environment", () => {
    const store = new RepoStore(root, () => "secret-token");
    const header = gitOut(root, ["config", "--get", "http.extraheader"]);
    expect(header).toBe(""); // nothing configured by default
    const env = (store as unknown as { env(): Record<string, string> }).env();
    const result = gitOutWith(env);
    expect(result).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`,
    );
  });

  it("does not write the token into the clone's config", () => {
    const store = new RepoStore(root, () => "secret-token");
    const dir = store.ensure("backend", seed.dir, "main");
    const config = readFileSync(join(dir, "config"), "utf8");
    expect(config).not.toContain("secret-token");
    expect(config).not.toContain(
      Buffer.from("x-access-token:secret-token").toString("base64"),
    );
    expect(config).not.toContain("extraheader");
    writeFileSync(join(root, "ok"), "");
  });
});

import { spawnSync } from "node:child_process";

function gitOutWith(env: Record<string, string>): string {
  return spawnSync("git", ["config", "--get", "http.extraheader"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).stdout.trim();
}
