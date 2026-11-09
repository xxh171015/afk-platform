import { describe, expect, it } from "vitest";
import { adapterByHost, hostRepoRef, tokensByHost } from "./by-host.ts";
import type { HostAdapter, PullRequestInfo, TokenSource } from "./types.ts";

// A worker may have credentials for several code hosts: each repo's calls go to its own host's adapter and tokens.

const info = (url: string): PullRequestInfo => ({
  number: 1,
  url,
  state: "open",
  draft: false,
  headSha: "sha",
  ci: "none",
  review: "none",
  mergedBy: null,
  mergedAt: null,
  mergedByPlatform: false,
});

function fakeAdapter(name: string): HostAdapter {
  return {
    openPullRequest: async () => info(name),
    getPullRequest: async () => info(name),
    getPullRequestBody: async () => name,
    updatePullRequestBody: async () => {},
    markReady: async () => info(name),
    closePullRequest: async () => info(name),
    deleteBranch: async () => "deleted",
    getBranchSha: async () => `${name}-sha`,
  };
}

describe("hostRepoRef", () => {
  it("reads the host with the namespace and name", () => {
    expect(hostRepoRef("git@git.corp.example:team/sub/api.git")).toEqual({
      host: "git.corp.example",
      owner: "team/sub",
      name: "api",
    });
  });
});

describe("adapterByHost", () => {
  const adapter = adapterByHost(
    new Map([
      ["github.com", fakeAdapter("github")],
      ["git.corp.example", fakeAdapter("gitlab")],
    ]),
  );

  it("sends each repo's calls to its host's adapter", async () => {
    const onGitLab = hostRepoRef("https://git.corp.example/team/api.git");
    const onGitHub = hostRepoRef("https://github.com/me/x.git");
    expect(
      await adapter.getPullRequestBody({ repo: onGitLab, number: 1 }),
    ).toBe("gitlab");
    expect(
      await adapter.getPullRequestBody({ repo: onGitHub, number: 1 }),
    ).toBe("github");
  });

  it("fails for a repo on a host this worker has no credentials for", async () => {
    await expect(
      adapter.getPullRequest({
        repo: hostRepoRef("https://elsewhere.example/a/b.git"),
        number: 1,
      }),
    ).rejects.toThrow("this worker has no credentials for elsewhere.example");
  });
});

describe("tokensByHost", () => {
  it("mints the token with the source of the repo's host", async () => {
    const source = (token: string): TokenSource => ({
      tokenFor: async () => token,
    });
    const tokens = tokensByHost(
      new Map([
        ["github.com", source("app-token")],
        ["git.corp.example", source("pat")],
      ]),
    );
    expect(
      await tokens.tokenFor({
        repo: hostRepoRef("https://git.corp.example/team/api.git"),
        permissions: { contents: "write" },
      }),
    ).toBe("pat");
    await expect(
      tokens.tokenFor({
        repo: hostRepoRef("https://elsewhere.example/a/b.git"),
        permissions: { contents: "read" },
      }),
    ).rejects.toThrow("no credentials for elsewhere.example");
  });
});
