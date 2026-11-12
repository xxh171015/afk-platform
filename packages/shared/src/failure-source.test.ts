import { describe, expect, it } from "vitest";
import {
  FAILURE_SOURCE_OF_REASON,
  failureSourceOf,
  isSandboxOomError,
  PAUSE_REASONS,
  pauseReasonLabel,
  REASON_CODES,
} from "./failure-source.ts";

describe("failure source of a reason code", () => {
  it("follows the spec's table", () => {
    expect(failureSourceOf("gate-failed")).toBe("agent");
    expect(failureSourceOf("final-e2e-failed")).toBe("agent");
    expect(failureSourceOf("budget-exhausted")).toBe("agent");
    expect(failureSourceOf("merge-conflict")).toBe("spec");
    expect(failureSourceOf("integration-environment-failed")).toBe("spec");
    expect(failureSourceOf("update-branch-gate-failed")).toBe("spec");
    expect(failureSourceOf("planning-conflict")).toBe("spec");
    expect(failureSourceOf("bug-unlocated")).toBe("spec");
    expect(failureSourceOf("lease-expired")).toBe("platform");
    expect(failureSourceOf("sandbox-oom")).toBe("platform");
    expect(failureSourceOf("sync-error")).toBe("external");
  });

  it("does not count a ticket cancelled with the one it waited for", () => {
    expect(failureSourceOf("upstream-cancelled")).toBeNull();
  });

  it("gives every reason code a source (null only for upstream-cancelled)", () => {
    for (const code of REASON_CODES) {
      expect(FAILURE_SOURCE_OF_REASON[code], code).not.toBeUndefined();
    }
    const uncounted = REASON_CODES.filter(
      (code) => FAILURE_SOURCE_OF_REASON[code] === null,
    );
    expect(uncounted).toEqual(["upstream-cancelled"]);
  });

  it("treats an unknown code as the platform's", () => {
    expect(failureSourceOf("something-new")).toBe("platform");
  });

  it("recognises a sandbox OOMKilled error as sandbox-oom", () => {
    expect(isSandboxOomError("sandbox-oom: container OOMKilled")).toBe(true);
    expect(isSandboxOomError("OOMKilled")).toBe(true);
    expect(isSandboxOomError("docker daemon not running")).toBe(false);
  });
});

describe("pause reason labels", () => {
  it("names each code in Chinese, and keeps an unknown code as itself", () => {
    expect(pauseReasonLabel("budget-exhausted")).toBe("agent 时间用完");
    expect(pauseReasonLabel("update-branch-conflict")).toBe("合 main 有冲突");
    expect(pauseReasonLabel("update-branch-gate-failed")).toBe(
      "合 main 后门禁失败",
    );
    expect(pauseReasonLabel(null)).toBe("已暂停");
    expect(pauseReasonLabel("mystery")).toBe("mystery");
    expect(PAUSE_REASONS.map(pauseReasonLabel)).toEqual([
      "agent 时间用完",
      "合 main 有冲突",
      "合 main 后门禁失败",
    ]);
  });
});

describe("failure source of a failed job", () => {
  const external = [
    "GitHub answered 502 reading pull request 12",
    "GitHub refused to mark pull request 3 ready (503): Service Unavailable",
    "GitLab answered 500 opening a pull request for agent/1",
    "GitLab did not describe the token's user: HTTP 401",
    "GitLab answered 401 for GET xuxinghua/backend/repository/branches/master",
    "git fetch failed: remote: Invalid username or token. Password authentication is not supported",
    "cursor-agent: Authentication required. Please run 'cursor-agent login'",
    "agent run failed: rate limit exceeded, try again later",
    "HTTP 429 Too Many Requests",
    "npm error code EAI_AGAIN request to https://registry.npmjs.org/vitest failed",
    "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmmirror.com/zod: getaddrinfo ENOTFOUND registry.npmmirror.com",
    "docker: Error response from daemon: Get https://registry-1.docker.io/v2/: net/http: TLS handshake timeout",
    "could not push agent/T-4: fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    "ActionRequiredError: Unauthorized request",
    "Error: unknown model 'claude-code'",
    "Error: quota exceeded: usage limit reached",
    "docker build of backend (backend) failed (exit 1):\nERROR: failed to solve",
    "Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试",
    "模型名无效，检查项目的默认模型或 AFK_MODEL",
    "Cursor 额度用完，充值或换模型后再试",
    "联调镜像构建失败，修好 Dockerfile 或基础镜像后再试",
  ];
  const platform = [
    "could not push agent/T-4: ! [rejected] agent/T-4 -> agent/T-4 (non-fast-forward)",
    "commit-tree failed: fatal: not a valid object name",
    "sandbox exited with code 137",
    "GitHub answered 404 reading pull request 512",
    "",
  ];

  it.each(external)("external: %s", (error) => {
    expect(failureSourceOf("job-failed", error)).toBe("external");
  });
  it.each(platform)("platform: %s", (error) => {
    expect(failureSourceOf("job-failed", error)).toBe("platform");
  });

  it("only reads the error for job-failed", () => {
    expect(failureSourceOf("gate-failed", "GitHub answered 502")).toBe("agent");
  });
});
