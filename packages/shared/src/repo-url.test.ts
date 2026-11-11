import { describe, expect, it } from "vitest";
import {
  commitHtmlUrl,
  ownerHtmlUrl,
  parseRepoUrl,
  repoDisplayName,
  repoHost,
  repoHtmlUrl,
  sameRepoUrl,
  treeHtmlUrl,
  tryParseRepoUrl,
} from "./repo-url.ts";

describe("parseRepoUrl", () => {
  it.each([
    [
      "https://github.com/me/afk-pilot-backend.git",
      { owner: "me", name: "afk-pilot-backend" },
    ],
    [
      "https://github.com/me/afk-pilot-backend",
      { owner: "me", name: "afk-pilot-backend" },
    ],
    [
      "git@github.com:me/afk-pilot-backend.git",
      { owner: "me", name: "afk-pilot-backend" },
    ],
    ["ssh://git@github.com/me/x.git", { owner: "me", name: "x" }],
    // GitLab's nested groups: the whole namespace is the owner
    [
      "https://git.corp.example/team/sub/deeper/api.git",
      { owner: "team/sub/deeper", name: "api" },
    ],
    [
      "git@git.corp.example:team/sub/api.git",
      { owner: "team/sub", name: "api" },
    ],
    [
      "ssh://git@git.corp.example:2222/team/sub/api.git",
      { owner: "team/sub", name: "api" },
    ],
  ])("reads %s", (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it("writes a nested group's address back as it was", () => {
    const url = "https://git.corp.example/team/sub/api.git";
    expect(repoHtmlUrl(url)).toBe("https://git.corp.example/team/sub/api");
    expect(repoDisplayName(url)).toBe("team/sub/api");
  });

  it("refuses what is not a repository address", () => {
    expect(() => parseRepoUrl("/srv/git/repo.git")).toThrow(RangeError);
    expect(tryParseRepoUrl("/srv/git/repo.git")).toBeNull();
  });
});

describe("sameRepoUrl", () => {
  it("treats https and ssh spellings of the same repo as equal", () => {
    expect(
      sameRepoUrl(
        "https://github.com/acme/backend.git",
        "git@github.com:acme/backend.git",
      ),
    ).toBe(true);
    expect(
      sameRepoUrl(
        "https://github.com/acme/backend.git",
        "https://github.com/other/other.git",
      ),
    ).toBe(false);
  });
});

describe("repoHost", () => {
  it.each([
    ["https://github.com/me/x.git", "github.com"],
    ["https://GitLab.Corp.Example/team/sub/api.git", "gitlab.corp.example"],
    ["git@git.corp.example:team/api.git", "git.corp.example"],
    ["ssh://git@git.corp.example:2222/team/api.git", "git.corp.example"],
  ])("finds the host of %s", (url, host) => {
    expect(repoHost(url)).toBe(host);
  });

  it("is null for what is not a repository address", () => {
    expect(repoHost("/srv/git/repo.git")).toBeNull();
  });
});

describe("browse URLs", () => {
  const github = "https://github.com/acme/shop-backend.git";
  const gitlab = "https://gitlab.example.org/acme/api.git";

  it("opens the repository and its owner on the host", () => {
    expect(repoHtmlUrl(github)).toBe("https://github.com/acme/shop-backend");
    expect(ownerHtmlUrl(github)).toBe("https://github.com/acme");
    expect(repoDisplayName(github)).toBe("acme/shop-backend");
    expect(repoHtmlUrl(gitlab)).toBe("https://gitlab.example.org/acme/api");
    expect(repoHtmlUrl("not-a-url")).toBeNull();
  });

  it("opens a commit and a branch on GitHub and GitLab", () => {
    expect(commitHtmlUrl(github, "abc123def")).toBe(
      "https://github.com/acme/shop-backend/commit/abc123def",
    );
    expect(treeHtmlUrl(github, "spec/ab12cd/export")).toBe(
      "https://github.com/acme/shop-backend/tree/spec/ab12cd/export",
    );
    expect(commitHtmlUrl(gitlab, "deadbeef")).toBe(
      "https://gitlab.example.org/acme/api/-/commit/deadbeef",
    );
    expect(treeHtmlUrl(gitlab, "main")).toBe(
      "https://gitlab.example.org/acme/api/-/tree/main",
    );
  });

  it("turns an ssh clone address into https pages", () => {
    expect(repoHtmlUrl("git@github.com:acme/api.git")).toBe(
      "https://github.com/acme/api",
    );
    expect(commitHtmlUrl("git@github.com:acme/api.git", "abc")).toBe(
      "https://github.com/acme/api/commit/abc",
    );
  });
});
