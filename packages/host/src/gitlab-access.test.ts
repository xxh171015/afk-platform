import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGitLabAccess } from "./gitlab-access.ts";
import { FakeGitLab } from "./testing/index.ts";

const token = "glpat-test-token";
const repo = { owner: "acme", name: "backend", host: "gitlab.example" };

let gitlab: FakeGitLab;
beforeEach(async () => {
  gitlab = new FakeGitLab({
    owner: repo.owner,
    repo: repo.name,
    token,
  });
  await gitlab.start();
});
afterEach(() => gitlab.stop());

const check = () =>
  checkGitLabAccess(
    {
      apiUrl: gitlab.url,
      tokens: { tokenFor: async () => token },
    },
    repo,
  );

describe("whether a GitLab PAT can work on a repo", () => {
  it("is not-member, with who to add as Developer, when the token user is not in the project", async () => {
    gitlab.member = false;
    gitlab.username = "alice";
    expect(await check()).toEqual({
      state: "not-member",
      username: "alice",
      fix: "请项目 Maintainer 把〈alice〉加为 Developer",
      hints: [],
      tokenExpiresAt: null,
    });
  });

  it("hints that the platform is using a personal token when the user can push the default branch", async () => {
    gitlab.canPush = true;
    gitlab.username = "alice";
    expect(await check()).toMatchObject({
      state: "ok",
      username: "alice",
      hints: ["personal-token"],
    });
  });

  it("hints when Developers can merge the default branch, and not when only Maintainers can", async () => {
    gitlab.canPush = false;
    gitlab.mergeAccessLevel = 30;
    expect(await check()).toMatchObject({
      state: "ok",
      hints: ["developers-can-merge"],
    });

    gitlab.mergeAccessLevel = 40;
    expect(await check()).toMatchObject({ state: "ok", hints: [] });
  });

  it("hints when the default branch is not protected, which lets Developers merge", async () => {
    gitlab.canPush = false;
    gitlab.protectDefault = false;
    expect(await check()).toMatchObject({
      state: "ok",
      hints: ["developers-can-merge"],
    });
  });

  it("says which setup files the default branch or afk/setup has", async () => {
    gitlab.canPush = false;
    gitlab.files.add(".sandcastle/gates.yaml");
    expect(await check()).toMatchObject({
      state: "ok",
      files: { gates: true, integrationCompose: false },
    });

    gitlab.files.clear();
    gitlab.branchFiles.set("afk/setup", new Set([".sandcastle/gates.yaml"]));
    expect(await check()).toMatchObject({
      files: { gates: true, integrationCompose: false },
    });
  });

  it("reads the PAT's expiry date, including when the user is not a member", async () => {
    gitlab.tokenExpiresAt = "2026-12-09";
    gitlab.canPush = false;
    expect(await check()).toMatchObject({
      state: "ok",
      tokenExpiresAt: "2026-12-09",
    });

    gitlab.member = false;
    expect(await check()).toMatchObject({
      state: "not-member",
      tokenExpiresAt: "2026-12-09",
    });
  });

  it("omits the expiry when GitLab does not describe the token, so a stored date is not wiped", async () => {
    gitlab.hideTokenExpiry = true;
    gitlab.canPush = false;
    expect(await check()).not.toHaveProperty("tokenExpiresAt");
  });
});
