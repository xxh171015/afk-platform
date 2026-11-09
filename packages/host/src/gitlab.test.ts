import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitLabAdapter } from "./gitlab.ts";
import { FakeGitLab } from "./testing/fake-gitlab.ts";
import { HostError } from "./types.ts";

const token = "glpat-test-token";
const repo = {
  owner: "xuxinghua",
  name: "afk-pilot-backend",
  host: "git.example",
};
let gitlab: FakeGitLab;
const adapter = () =>
  createGitLabAdapter({
    apiUrl: gitlab.url,
    tokens: { tokenFor: async () => token },
  });
const open = (
  a = adapter(),
  over: Partial<
    Parameters<ReturnType<typeof adapter>["openPullRequest"]>[0]
  > = {},
) =>
  a.openPullRequest({
    repo,
    head: "spec/s-1",
    base: "master",
    title: "S-1 add export",
    body: "Spec: S-1",
    ...over,
  });

beforeEach(async () => {
  gitlab = new FakeGitLab({
    owner: repo.owner,
    repo: repo.name,
    token,
  });
  await gitlab.start();
});
afterEach(() => gitlab.stop());

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
    expect(pr.url).toContain("/-/merge_requests/1");
    expect(gitlab.mergeRequests()[0]).toMatchObject({
      source: "spec/s-1",
      target: "master",
      title: "S-1 add export",
      description: "Spec: S-1",
    });
  });

  it("puts Draft: on the title when the pull request should stay a draft", async () => {
    const pr = await open(adapter(), { draft: true });
    expect(pr.draft).toBe(true);
    expect(gitlab.mergeRequests()[0]?.title).toBe("Draft: S-1 add export");
  });

  it("does not put Draft: twice when the title already has it", async () => {
    await open(adapter(), { draft: true, title: "Draft: S-1 add export" });
    expect(gitlab.mergeRequests()[0]?.title).toBe("Draft: S-1 add export");
  });

  it("returns the pull request that is already there when GitLab answers 409", async () => {
    const a = adapter();
    const first = await open(a);
    const second = await open(a);
    expect(second.number).toBe(first.number);
    expect(gitlab.mergeRequests()).toHaveLength(1);
    expect(
      gitlab.requests.some(
        (r) => r.startsWith("POST ") && r.endsWith("/merge_requests"),
      ),
    ).toBe(true);
    expect(
      gitlab.requests.some((r) =>
        r.includes("/merge_requests?source_branch=spec%2Fs-1&state=opened"),
      ),
    ).toBe(true);
  });

  it("encodes a nested group's path as one project id", async () => {
    await gitlab.stop();
    gitlab = new FakeGitLab({
      owner: "team/sub",
      repo: "api",
      token,
    });
    await gitlab.start();
    const nested = { owner: "team/sub", name: "api", host: "git.example" };
    const pr = await adapter().openPullRequest({
      repo: nested,
      head: "spec/s-1",
      base: "master",
      title: "S-1",
      body: "",
    });
    expect(pr.number).toBe(1);
    expect(
      gitlab.requests.some((r) =>
        r.includes(`/projects/${encodeURIComponent("team/sub/api")}/`),
      ),
    ).toBe(true);
  });

  it("throws a HostError with the status when GitLab refuses", async () => {
    const error = await adapter()
      .openPullRequest({
        repo: { owner: "me", name: "other", host: "git.example" },
        head: "spec/x",
        base: "master",
        title: "t",
        body: "",
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error.status).toBe(404);
    expect(error.message).not.toContain(token);
  });

  it("sends the token in a header only", async () => {
    await open();
    expect(gitlab.requests.some((r) => r.includes("glpat-"))).toBe(false);
  });
});

describe("getPullRequest", () => {
  it("reports a merged pull request as merged", async () => {
    const a = adapter();
    await open(a);
    gitlab.mergeMr(1);
    expect((await a.getPullRequest({ repo, number: 1 })).state).toBe("merged");
  });

  it("tells a closed pull request from a merged one", async () => {
    const a = adapter();
    await open(a);
    gitlab.closeMr(1);
    expect((await a.getPullRequest({ repo, number: 1 })).state).toBe("closed");
  });

  it("stores the iid as the number", async () => {
    await open();
    expect((await adapter().getPullRequest({ repo, number: 1 })).number).toBe(
      1,
    );
  });

  it("takes CI from head_pipeline", async () => {
    const a = adapter();
    await open(a);
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("none");
    gitlab.setPipeline(1, "running");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("pending");
    gitlab.setPipeline(1, "success");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("success");
    gitlab.setPipeline(1, "skipped");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("success");
    gitlab.setPipeline(1, "failed");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("failure");
    gitlab.setPipeline(1, "canceled");
    expect((await a.getPullRequest({ repo, number: 1 })).ci).toBe("failure");
  });

  it("treats an approval as approved, and requested_changes as changes-requested", async () => {
    const a = adapter();
    await open(a);
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe("none");
    gitlab.approveMr(1, "alice");
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe(
      "approved",
    );
    gitlab.setReviewer(1, "bob", "requested_changes");
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe(
      "changes-requested",
    );
  });

  it("skips reviewers and approvals when GitLab has no such route", async () => {
    const a = adapter();
    await open(a);
    gitlab.hideReviewers = true;
    gitlab.hideApprovals = true;
    expect((await a.getPullRequest({ repo, number: 1 })).review).toBe("none");
  });

  it("does not read comments", async () => {
    const a = adapter();
    await open(a);
    const before = gitlab.requests.length;
    await a.getPullRequest({ repo, number: 1 });
    expect(
      gitlab.requests
        .slice(before)
        .some((r) => r.includes("/notes") || r.includes("/discussions")),
    ).toBe(false);
  });

  it("reports a conflict with the default branch from has_conflicts", async () => {
    const a = adapter();
    await open(a);
    expect(
      (await a.getPullRequest({ repo, number: 1 })).conflictsWithDefault,
    ).toBe(false);
    gitlab.setHasConflicts(1, true);
    expect(
      (await a.getPullRequest({ repo, number: 1 })).conflictsWithDefault,
    ).toBe(true);
  });

  it("reports who merged it and when", async () => {
    const a = adapter();
    await open(a);
    gitlab.mergeMr(1, { by: "alice", at: "2026-11-09T10:00:00.000Z" });
    expect(await a.getPullRequest({ repo, number: 1 })).toMatchObject({
      state: "merged",
      mergedBy: "alice",
      mergedAt: "2026-11-09T10:00:00.000Z",
      mergedByPlatform: false,
    });
  });

  it("does not flag a merge when the token can push the default branch", async () => {
    const a = adapter();
    await open(a);
    gitlab.username = "xuxinghua";
    gitlab.canPush = true;
    gitlab.mergeMr(1, { by: "xuxinghua" });
    const before = gitlab.requests.length;
    expect((await a.getPullRequest({ repo, number: 1 })).mergedByPlatform).toBe(
      false,
    );
    expect(gitlab.requests.slice(before).some((r) => r.endsWith("/user"))).toBe(
      false,
    );
  });

  it("flags a merge by the token user when the token cannot push the default branch", async () => {
    const a = adapter();
    await open(a);
    gitlab.username = "bot";
    gitlab.canPush = false;
    gitlab.mergeMr(1, { by: "bot" });
    expect((await a.getPullRequest({ repo, number: 1 })).mergedByPlatform).toBe(
      true,
    );
    gitlab.mergeMr(1, { by: "alice" });
    expect((await a.getPullRequest({ repo, number: 1 })).mergedByPlatform).toBe(
      false,
    );
  });

  it("throws a HostError with Retry-After when GitLab answers 429", async () => {
    const a = adapter();
    await open(a);
    gitlab.rateLimitSeconds = 12;
    const error = await a.getPullRequest({ repo, number: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({
      status: 429,
      retryAfterSeconds: 12,
      message: "GitLab answered 429; retry after 12s",
    });
    expect(error.message).not.toContain(token);
  });
});

describe("updatePullRequestBody", () => {
  it("writes the description and reads it back", async () => {
    const a = adapter();
    await open(a);
    await a.updatePullRequestBody({
      repo,
      number: 1,
      body: "Spec: S-1\n\nupdated",
    });
    expect(await a.getPullRequestBody({ repo, number: 1 })).toBe(
      "Spec: S-1\n\nupdated",
    );
  });
});

describe("markReady", () => {
  const openDraft = () => open(adapter(), { draft: true });

  it("turns a draft ready by taking Draft: off the title", async () => {
    await openDraft();
    const ready = await adapter().markReady({ repo, number: 1 });
    expect(ready).toMatchObject({ number: 1, state: "open", draft: false });
    expect(gitlab.mergeRequests()[0]?.title).toBe("S-1 add export");
  });

  it("sends nothing for a pull request that is not a draft (a person got there first)", async () => {
    await open();
    const before = gitlab.requests.length;
    const result = await adapter().markReady({ repo, number: 1 });
    expect(result.draft).toBe(false);
    expect(
      gitlab.requests.slice(before).filter((r) => r.startsWith("PUT ")),
    ).toEqual([]);
  });
});

describe("closePullRequest", () => {
  it("closes an open pull request with state_event=close", async () => {
    await open();
    const closed = await adapter().closePullRequest({ repo, number: 1 });
    expect(closed).toMatchObject({ number: 1, state: "closed" });
    expect(gitlab.mergeRequests()[0]?.state).toBe("closed");
    expect(
      gitlab.requests.some(
        (r) => r.startsWith("PUT ") && r.endsWith("/merge_requests/1"),
      ),
    ).toBe(true);
  });

  it("leaves a merged pull request alone: it is reported merged and nothing is sent", async () => {
    await open();
    gitlab.mergeMr(1);
    const before = gitlab.requests.length;
    const result = await adapter().closePullRequest({ repo, number: 1 });
    expect(result.state).toBe("merged");
    expect(
      gitlab.requests.slice(before).filter((r) => r.startsWith("PUT ")),
    ).toEqual([]);
  });
});

describe("getBranchSha", () => {
  it("reads the commit the branch is at", async () => {
    gitlab.setBranchSha("master", "def789abc012");
    expect(await adapter().getBranchSha({ repo, branch: "master" })).toBe(
      "def789abc012",
    );
  });

  it("is a HostError when GitLab has no such branch", async () => {
    gitlab.missingBranches.add("master");
    await expect(
      adapter().getBranchSha({ repo, branch: "master" }),
    ).rejects.toMatchObject({ name: "HostError", status: 404 });
  });
});

describe("deleteBranch", () => {
  it("deletes a branch, and says it is gone when GitLab answers 404", async () => {
    gitlab.addBranch("spec/s-1");
    const a = adapter();
    expect(await a.deleteBranch({ repo, branch: "spec/s-1" })).toBe("deleted");
    expect(gitlab.branches()).toEqual([]);
    expect(await a.deleteBranch({ repo, branch: "spec/s-1" })).toBe("gone");
    expect(
      gitlab.requests.some((r) =>
        r.includes(`/repository/branches/${encodeURIComponent("spec/s-1")}`),
      ),
    ).toBe(true);
  });

  it("does not take a 403 for a branch that is gone", async () => {
    gitlab.addBranch("agent/T-1");
    gitlab.protectBranch("agent/T-1");
    await expect(
      adapter().deleteBranch({ repo, branch: "agent/T-1" }),
    ).rejects.toMatchObject({ name: "HostError", status: 403 });
    expect(gitlab.branches()).toEqual(["agent/T-1"]);
  });

  it("throws a HostError with the status when GitLab refuses", async () => {
    gitlab.addBranch("agent/T-1");
    gitlab.refuseBranchDeletes = true;
    await expect(
      adapter().deleteBranch({ repo, branch: "agent/T-1" }),
    ).rejects.toMatchObject({ name: "HostError", status: 403 });
  });
});
