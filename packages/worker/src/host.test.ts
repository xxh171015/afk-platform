import type { HostAdapter, PullRequestInfo } from "@afk/host";
import { HostError } from "@afk/host";
import { describe, expect, it } from "vitest";
import { InfrastructureError } from "./executor.ts";
import { runHostTask } from "./host.ts";

const info = (
  number: number,
  extra: Partial<PullRequestInfo> = {},
): PullRequestInfo => ({
  number,
  url: `https://github.com/me/pilot/pull/${number}`,
  state: "open",
  draft: false,
  headSha: `sha${number}`,
  ci: "pending",
  review: "none",
  ...extra,
});
const ref = () => ({ owner: "me", name: "pilot" });
const log = () => {};
const open = {
  kind: "open-pr" as const,
  repoUrl: "https://github.com/me/pilot.git",
  base: "main",
  head: "spec/export",
  title: "S-1 Export",
  body: "Spec: S-1",
  draft: false,
};

describe("an open-pr task", () => {
  it("opens the pull request the task describes and reports what the host said", async () => {
    const calls: unknown[] = [];
    const adapter: HostAdapter = {
      async openPullRequest(input) {
        calls.push(input);
        return info(7);
      },
      getPullRequest: async () => info(7),
    };
    const result = await runHostTask({ adapter, repoRef: ref }, open, log);
    expect(calls).toEqual([
      {
        repo: ref(),
        head: "spec/export",
        base: "main",
        title: "S-1 Export",
        body: "Spec: S-1",
        draft: false,
      },
    ]);
    expect(result).toEqual({ stage: "open-pr", outcome: "opened", ...info(7) });
  });

  it("fails as an infrastructure problem when the host refuses, so the job is tried again", async () => {
    const adapter: HostAdapter = {
      openPullRequest: async () => {
        throw new HostError("GitHub answered 503 opening a pull request", 503);
      },
      getPullRequest: async () => info(1),
    };
    await expect(
      runHostTask({ adapter, repoRef: ref }, open, log),
    ).rejects.toThrow(InfrastructureError);
  });
});

describe("a host-sync task", () => {
  const sync = {
    kind: "host-sync" as const,
    pulls: [
      { id: 1, repoUrl: "u", number: 1 },
      { id: 2, repoUrl: "u", number: 2 },
    ],
  };

  it("reports each open pull request", async () => {
    const adapter: HostAdapter = {
      openPullRequest: async () => info(0),
      getPullRequest: async ({ number }) =>
        info(number, number === 2 ? { state: "merged" } : {}),
    };
    const result = await runHostTask({ adapter, repoRef: ref }, sync, log);
    expect(result).toEqual({
      stage: "host-sync",
      pulls: [
        {
          id: 1,
          state: "open",
          draft: false,
          headSha: "sha1",
          ci: "pending",
          review: "none",
        },
        {
          id: 2,
          state: "merged",
          draft: false,
          headSha: "sha2",
          ci: "pending",
          review: "none",
        },
      ],
    });
  });

  it("reports the one it could not read and still the others", async () => {
    const adapter: HostAdapter = {
      openPullRequest: async () => info(0),
      getPullRequest: async ({ number }) => {
        if (number === 1) throw new HostError("GitHub answered 502", 502);
        return info(number);
      },
    };
    const result = (await runHostTask(
      { adapter, repoRef: ref },
      sync,
      log,
    )) as { pulls: Record<string, unknown>[] };
    expect(result.pulls[0]).toEqual({ id: 1, error: "GitHub answered 502" });
    expect(result.pulls[1]).toMatchObject({ id: 2, state: "open" });
  });
});
