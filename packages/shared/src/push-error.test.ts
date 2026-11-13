import { describe, expect, it } from "vitest";
import {
  BRANCH_MOVED_BRIEF,
  blockedReasonForReportedPush,
  classifyPushError,
  formatPushFailure,
  HOST_PERMISSION_BRIEF,
  isDeterministicPushFailure,
  isNetworkPushError,
  reportedPushError,
  tipsFromPushFailure,
} from "./push-error.ts";
import {
  CURSOR_AUTH_BRIEF,
  QUOTA_EXHAUSTED_BRIEF,
} from "./unrecoverable-job-error.ts";

describe("reportedPushError", () => {
  it("maps a worker brief onto the ticket or wrap-up reason", () => {
    expect(blockedReasonForReportedPush(BRANCH_MOVED_BRIEF)).toBe(
      "branch-moved",
    );
    expect(blockedReasonForReportedPush(HOST_PERMISSION_BRIEF)).toBe(
      "job-failed",
    );
    expect(
      blockedReasonForReportedPush(
        "! [rejected] agent/T-1 -> agent/T-1 (non-fast-forward)",
      ),
    ).toBeUndefined();
    expect(isDeterministicPushFailure("branch-moved")).toBe(true);
    expect(isDeterministicPushFailure("host-permission")).toBe(true);
    expect(isDeterministicPushFailure("network")).toBe(false);
  });

  it("reads the remote tip and this round's start out of a formatted brief", () => {
    expect(
      tipsFromPushFailure(
        [
          BRANCH_MOVED_BRIEF,
          "远端 tip: aaa111",
          "本轮起点: bbb222",
          "! [rejected] (non-fast-forward)",
        ].join("\n"),
      ),
    ).toEqual({ remoteTip: "aaa111", startedFrom: "bbb222" });
  });

  it("only trusts worker briefs, not raw git text", () => {
    expect(reportedPushError(BRANCH_MOVED_BRIEF)).toBe("branch-moved");
    expect(reportedPushError(HOST_PERMISSION_BRIEF)).toBe("host-permission");
    expect(
      reportedPushError(
        "! [rejected] agent/T-1 -> agent/T-1 (non-fast-forward)",
      ),
    ).toBeNull();
  });
});

describe("classifyPushError", () => {
  it.each([
    "! [rejected] agent/T-1 -> agent/T-1 (non-fast-forward)",
    "! [rejected] agent/T-1 -> agent/T-1 (fetch first)",
    "error: failed to push some refs\nstale info: refs/heads/agent/T-1 is at 111 but expected 222",
    "Updates were rejected because the tip of your current branch is behind",
    BRANCH_MOVED_BRIEF,
  ])("names a moved branch: %s", (error) => {
    expect(classifyPushError(error)).toBe("branch-moved");
  });

  it.each([
    "remote: error: GH006: Protected branch update failed for refs/heads/agent/T-1",
    "remote: GitLab: You are not allowed to push code to protected branches on this project",
    "remote: Permission to shop/backend.git denied to afk-platform[bot]",
    HOST_PERMISSION_BRIEF,
  ])("names a host permission refusal: %s", (error) => {
    expect(classifyPushError(error)).toBe("host-permission");
  });

  it.each([
    "fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com",
    "Failed to connect to github.com port 443: Connection timed out",
    "RPC failed; HTTP 502",
    "remote: fatal error in commit_refs",
    "! [remote rejected] agent/T-1 -> agent/T-1 (failure)",
    "remote: fatal error in commit_refs\n! [remote rejected] agent/T-1 -> agent/T-1 (failure)",
  ])("names a network blip: %s", (error) => {
    expect(classifyPushError(error)).toBe("network");
    expect(isNetworkPushError(error)).toBe(true);
  });

  it("does not treat a merge that lost the race with the integration branch as a ticket-branch move", () => {
    expect(
      classifyPushError(
        "could not advance spec/abc123/s: it kept moving (! [rejected] spec/s -> spec/s (non-fast-forward))",
      ),
    ).toBe("other");
  });

  it("does not treat Cursor key or quota sentences as a host permission refusal", () => {
    expect(classifyPushError(CURSOR_AUTH_BRIEF)).toBe("other");
    expect(classifyPushError(QUOTA_EXHAUSTED_BRIEF)).toBe("other");
    expect(classifyPushError("ActionRequiredError: Unauthorized request")).toBe(
      "other",
    );
  });
});

describe("formatPushFailure", () => {
  it("writes the branch-moved brief with the remote tip and this round's start", () => {
    expect(
      formatPushFailure(
        "! [rejected] agent/T-1 -> agent/T-1 (non-fast-forward)",
        { remoteTip: "aaa111", startedFrom: "bbb222" },
      ),
    ).toBe(
      [
        BRANCH_MOVED_BRIEF,
        "远端 tip: aaa111",
        "本轮起点: bbb222",
        "! [rejected] agent/T-1 -> agent/T-1 (non-fast-forward)",
      ].join("\n"),
    );
  });

  it("keeps a branch-moved brief that already has the tips", () => {
    const formatted = formatPushFailure("non-fast-forward", {
      remoteTip: "aaa",
      startedFrom: "bbb",
    });
    expect(formatPushFailure(formatted)).toBe(formatted);
  });

  it("replaces a permission refusal with the host-permission brief, not the Cursor key sentence", () => {
    expect(
      formatPushFailure(
        "remote: Permission to shop/backend.git denied to afk-platform[bot]",
      ),
    ).toBe(HOST_PERMISSION_BRIEF);
    expect(HOST_PERMISSION_BRIEF).not.toBe(CURSOR_AUTH_BRIEF);
    expect(HOST_PERMISSION_BRIEF).not.toContain("CURSOR_API_KEY");
  });

  it.each([
    "fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com",
    "remote: fatal error in commit_refs",
    "! [remote rejected] agent/T-1 -> agent/T-1 (failure)",
  ])(
    "leaves a network error unchanged so the worker can retry it: %s",
    (error) => {
      expect(formatPushFailure(error)).toBe(error);
      expect(isNetworkPushError(formatPushFailure(error))).toBe(true);
    },
  );
});
