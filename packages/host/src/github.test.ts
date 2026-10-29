import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitHubAdapter } from "./github.ts";
import { createAppTokenSource } from "./github-app.ts";
import { FakeGitHub } from "./testing/index.ts";
import { HostError, parseRepoUrl } from "./types.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const repo = { owner: "me", name: "afk-pilot-backend" };
let github: FakeGitHub;
const adapter = () =>
  createGitHubAdapter({
    apiUrl: github.url,
    tokens: createAppTokenSource({
      credentials: { appId: "1", installationId: "2", privateKey },
      apiUrl: github.url,
    }),
  });
const open = (a = adapter()) =>
  a.openPullRequest({
    repo,
    head: "spec/s-1",
    base: "main",
    title: "S-1 add export",
    body: "Spec: S-1",
  });

beforeEach(async () => {
  github = new FakeGitHub({
    appId: "1",
    installationId: "2",
    publicKey,
    owner: "me",
    repo: "afk-pilot-backend",
  });
  await github.start();
});
afterEach(() => github.stop());

describe("openPullRequest", () => {
  it("opens a pull request from the branch to the base, with title and description", async () => {
    const pr = await open();
    expect(pr).toMatchObject({
      number: 1,
      state: "open",
      draft: false,
      ci: "none",
      review: "none",
    });
    expect(github.pullRequests()[0]).toMatchObject({
      head: "spec/s-1",
      base: "main",
      title: "S-1 add export",
      body: "Spec: S-1",
    });
  });

  it("asks for a token that can write pull requests and nothing more", async () => {
    await open();
    expect(github.tokensIssued[0]).toMatchObject({
      repositories: ["afk-pilot-backend"],
      permissions: { pull_requests: "write", contents: "read" },
    });
  });

  it("returns the pull request that is already there when it is asked twice", async () => {
    const a = adapter();
    const first = await open(a);
    const second = await open(a);
    expect(second.number).toBe(first.number);
    expect(github.pullRequests()).toHaveLength(1);
  });

  it("throws a HostError with the status when GitHub refuses", async () => {
    const error = await adapter()
      .openPullRequest({
        repo: { owner: "me", name: "other" },
        head: "spec/x",
        base: "main",
        title: "t",
        body: "",
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error.status).toBe(404);
  });
});

describe("getPullRequest", () => {
  it("reports a merged pull request as merged", async () => {
    const a = adapter();
    await open(a);
    github.mergePull(1);
    expect((await a.getPullRequest({ repo, number: 1 })).state).toBe("merged");
  });

  it("tells a closed pull request from a merged one", async () => {
    const a = adapter();
    await open(a);
    github.closePull(1);
    expect((await a.getPullRequest({ repo, number: 1 })).state).toBe("closed");
  });

  it("sums up CI over check runs and commit statuses", async () => {
    const a = adapter();
    const { headSha } = await open(a);
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("none");
    github.setChecks(headSha, [
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]);
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("pending");
    github.setChecks(headSha, [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "skipped" },
    ]);
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("success");
    github.setStatus(headSha, "failure");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("failure");
  });

  it("goes by each reviewer's latest verdict", async () => {
    const a = adapter();
    await open(a);
    github.addReview(1, { user: "ann", state: "CHANGES_REQUESTED" });
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe(
      "changes-requested",
    );
    github.addReview(1, { user: "ann", state: "APPROVED" });
    github.addReview(1, { user: "ann", state: "COMMENTED" });
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe(
      "approved",
    );
  });

  it("uses conditional requests: a second look at an unchanged pull request is answered 304 and still complete", async () => {
    const a = adapter();
    const { headSha } = await open(a);
    github.setChecks(headSha, [{ status: "completed", conclusion: "success" }]);
    const first = await a.getPullRequest({ repo, number: 1 });
    const before = github.notModified;
    const second = await a.getPullRequest({ repo, number: 1 });
    expect(second).toEqual(first);
    expect(github.notModified - before).toBe(4); // pull, reviews, check runs, status
  });

  it("sees a change after a 304 run", async () => {
    const a = adapter();
    await open(a);
    await a.getPullRequest({ repo, number: 1 });
    github.mergePull(1);
    expect((await a.getPullRequest({ repo, number: 1 })).state).toBe("merged");
  });

  it("sends the token in a header only, and asks for read permissions", async () => {
    const a = adapter();
    await open(a);
    await a.getPullRequest({ repo, number: 1 });
    expect(github.tokensIssued.at(-1)?.permissions).toEqual({
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    });
    expect(github.requests.some((r) => r.includes("ghs_"))).toBe(false);
  });
});

describe("closePullRequest", () => {
  it("closes an open pull request, and reports it closed", async () => {
    await open();
    const closed = await adapter().closePullRequest({ repo, number: 1 });
    expect(closed).toMatchObject({ number: 1, state: "closed" });
    expect(github.pullRequests()[0]).toMatchObject({
      state: "closed",
      merged: false,
    });
  });

  it("leaves a merged pull request alone: it is reported merged and nothing is sent", async () => {
    await open();
    github.mergePull(1);
    const before = github.requests.length;
    const result = await adapter().closePullRequest({ repo, number: 1 });
    expect(result.state).toBe("merged");
    expect(
      github.requests.slice(before).filter((r) => r.startsWith("PATCH")),
    ).toEqual([]);
  });

  it("asks for a token that can write pull requests", async () => {
    await open();
    await adapter().closePullRequest({ repo, number: 1 });
    expect(github.tokensIssued.at(-1)?.permissions).toMatchObject({
      pull_requests: "write",
    });
  });
});

describe("deleteBranch", () => {
  it("deletes a branch, and says it is gone when asked again", async () => {
    github.addBranch("spec/s-1");
    const a = adapter();
    expect(await a.deleteBranch({ repo, branch: "spec/s-1" })).toBe("deleted");
    expect(github.branches()).toEqual([]);
    expect(await a.deleteBranch({ repo, branch: "spec/s-1" })).toBe("gone");
  });

  it("asks for a token that can write contents", async () => {
    github.addBranch("agent/T-1");
    await adapter().deleteBranch({ repo, branch: "agent/T-1" });
    expect(github.tokensIssued.at(-1)?.permissions).toMatchObject({
      contents: "write",
    });
  });

  it("does not take a 422 for a branch that is gone when GitHub refuses it for another reason", async () => {
    github.addBranch("agent/T-1");
    github.protectBranch("agent/T-1");
    await expect(
      adapter().deleteBranch({ repo, branch: "agent/T-1" }),
    ).rejects.toMatchObject({ name: "HostError", status: 422 });
    expect(github.branches()).toEqual(["agent/T-1"]);
  });

  it("throws a HostError with the status when GitHub refuses", async () => {
    github.addBranch("agent/T-1");
    github.refuseBranchDeletes = true;
    await expect(
      adapter().deleteBranch({ repo, branch: "agent/T-1" }),
    ).rejects.toMatchObject({ name: "HostError", status: 403 });
  });
});

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
  });
});
