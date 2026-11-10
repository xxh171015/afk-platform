import { describe, expect, it } from "vitest";
import {
  HOST_KINDS,
  hostKindOfUrl,
  pullAbbrev,
  pullPhrase,
} from "./host-kinds.ts";

describe("hostKindOfUrl", () => {
  it("knows the code hosts the platform has a seed template for", () => {
    expect(HOST_KINDS).toEqual(["github", "gitlab"]);
  });

  it.each([
    ["https://gitlab.com/acme/api.git", "gitlab"],
    ["git@gitlab.example.org:acme/api.git", "gitlab"],
    ["https://github.com/acme/api", "github"],
    ["git@github.com:acme/api.git", "github"],
    ["https://git.example.org/acme/api.git", "github"],
  ])("reads %s as %s", (url, kind) => {
    expect(hostKindOfUrl(url)).toBe(kind);
  });
});

describe("pullAbbrev", () => {
  it("says MR on GitLab and PR on GitHub", () => {
    expect(pullAbbrev("gitlab")).toBe("MR");
    expect(pullAbbrev("github")).toBe("PR");
    expect(pullPhrase("gitlab")).toBe("merge request");
    expect(pullPhrase("github")).toBe("pull request");
  });
});
