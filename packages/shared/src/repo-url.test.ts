import { describe, expect, it } from "vitest";
import {
  commitHtmlUrl,
  ownerHtmlUrl,
  parseRepoUrl,
  repoDisplayName,
  repoHtmlUrl,
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
  ])("reads %s", (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it("refuses what is not a repository address", () => {
    expect(() => parseRepoUrl("/srv/git/repo.git")).toThrow(RangeError);
    expect(tryParseRepoUrl("/srv/git/repo.git")).toBeNull();
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
