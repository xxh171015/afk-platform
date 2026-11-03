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
// the parts of the host these tests do not use
const noCleanup = {
  markReady: async (): Promise<PullRequestInfo> => {
    throw new Error("not used");
  },
  closePullRequest: async (): Promise<PullRequestInfo> => {
    throw new Error("not used");
  },
  deleteBranch: async (): Promise<"deleted" | "gone"> => {
    throw new Error("not used");
  },
  getPullRequestBody: async () => {
    throw new Error("not used");
  },
  updatePullRequestBody: async () => {
    throw new Error("not used");
  },
};
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

describe("a pr-ready task", () => {
  const task = {
    kind: "pr-ready" as const,
    pull: { id: 4, repoUrl: "https://github.com/me/pilot.git", number: 9 },
  };

  it("turns the pull request ready and reports what the host says now", async () => {
    const calls: unknown[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(1),
      getPullRequest: async () => info(9),
      markReady: async (input) => {
        calls.push(input);
        return info(9, { draft: false });
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(calls).toEqual([{ repo: ref(), number: 9 }]);
    expect(result).toEqual({ stage: "pr-ready", ...info(9, { draft: false }) });
  });

  it("fails as an infrastructure problem when the host refuses, so the job is tried again", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(1),
      getPullRequest: async () => info(9),
      markReady: async () => {
        throw new HostError(
          "GitHub refused to mark pull request 9 ready (403)",
          403,
        );
      },
    };
    await expect(
      runHostTask({ adapter, repoRef: ref }, task, log),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe("a patch-pr-body task", () => {
  const task = {
    kind: "patch-pr-body" as const,
    repoUrl: "https://github.com/me/pilot.git",
    number: 7,
    section: "pack here",
    summary: "summary here",
  };

  it("keeps what a person wrote outside the markers and replaces the marked section", async () => {
    const writes: string[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () => "Spec: S-1\n\nI added a note",
      updatePullRequestBody: async ({ body }) => {
        writes.push(body);
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(result).toEqual({ stage: "patch-pr-body", outcome: "patched" });
    expect(writes[0]).toContain("Spec: S-1");
    expect(writes[0]).toContain("I added a note");
    expect(writes[0]).toContain("pack here");
    expect(writes[0]).toContain("<!-- afk-acceptance-pack -->");
  });

  it("fails as an infrastructure problem when the host refuses, so the job is tried again", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () => "",
      updatePullRequestBody: async () => {
        throw new HostError("GitHub answered 403 updating pull request 7", 403);
      },
    };
    await expect(
      runHostTask({ adapter, repoRef: ref }, task, log),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe("an open-pr task", () => {
  it("opens the pull request the task describes and reports what the host said", async () => {
    const calls: unknown[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
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
      ...noCleanup,
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
      ...noCleanup,
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
      ...noCleanup,
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

describe("a spec-cleanup task", () => {
  const cleanup = (
    over: Partial<{
      pulls: { id: number; repoUrl: string; number: number }[];
      branches: { repoUrl: string; branch: string }[];
    }> = {},
  ) => ({
    kind: "spec-cleanup" as const,
    pulls: [{ id: 5, repoUrl: "https://github.com/me/pilot.git", number: 7 }],
    branches: [
      { repoUrl: "https://github.com/me/pilot.git", branch: "spec/export" },
      { repoUrl: "https://github.com/me/pilot.git", branch: "agent/T-1" },
      { repoUrl: "https://github.com/me/pilot.git", branch: "agent/S-1-final" },
    ],
    ...over,
  });
  function recorder(
    over: Partial<HostAdapter> = {},
  ): HostAdapter & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(0),
      getPullRequestBody: async () => "",
      updatePullRequestBody: async () => {},
      markReady: async () => info(0),
      closePullRequest: async ({ number }) => {
        calls.push(`close ${number}`);
        return info(number, { state: "closed" });
      },
      deleteBranch: async ({ branch }) => {
        calls.push(`delete ${branch}`);
        return "deleted";
      },
      ...over,
    };
  }

  it("closes the pull requests and deletes the branches, and reports the ids it closed", async () => {
    const adapter = recorder();
    const result = await runHostTask({ adapter, repoRef: ref }, cleanup(), log);
    expect(adapter.calls).toEqual([
      "close 7",
      "delete spec/export",
      "delete agent/T-1",
      "delete agent/S-1-final",
    ]);
    expect(result).toEqual({ stage: "spec-cleanup", closed: [5] });
  });

  it("does not report a pull request as closed when the host says a person merged it meanwhile", async () => {
    const adapter = recorder({
      closePullRequest: async ({ number }) => info(number, { state: "merged" }),
    });
    const result = await runHostTask({ adapter, repoRef: ref }, cleanup(), log);
    expect(result).toEqual({ stage: "spec-cleanup", closed: [] });
  });

  it("takes a branch that is already gone as deleted", async () => {
    const adapter = recorder({ deleteBranch: async () => "gone" });
    await expect(
      runHostTask({ adapter, repoRef: ref }, cleanup(), log),
    ).resolves.toMatchObject({ closed: [5] });
  });

  it("deletes the branches of a spec that carries its database's id, and refuses a look-alike", async () => {
    const adapter = recorder();
    const lines: string[] = [];
    const repoUrl = "https://github.com/me/pilot.git";
    await runHostTask(
      { adapter, repoRef: ref },
      cleanup({
        pulls: [],
        branches: [
          { repoUrl, branch: "spec/a1b2c3/export" },
          { repoUrl, branch: "agent/a1b2c3/T-1" },
          { repoUrl, branch: "agent/a1b2c3/S-1-final" },
          { repoUrl, branch: "agent/a1b2/T-1" },
          { repoUrl, branch: "release/a1b2c3/T-1" },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(adapter.calls).toEqual([
      "delete spec/a1b2c3/export",
      "delete agent/a1b2c3/T-1",
      "delete agent/a1b2c3/S-1-final",
    ]);
    expect(lines.filter((l) => /not a branch of a spec/.test(l))).toHaveLength(
      2,
    );
  });

  it("deletes only branches a spec makes, whatever the task says", async () => {
    const adapter = recorder();
    const lines: string[] = [];
    await runHostTask(
      { adapter, repoRef: ref },
      cleanup({
        pulls: [],
        branches: [
          { repoUrl: "https://github.com/me/pilot.git", branch: "main" },
          { repoUrl: "https://github.com/me/pilot.git", branch: "release/1.0" },
          {
            repoUrl: "https://github.com/me/pilot.git",
            branch: "agent/T-1/../x",
          },
          { repoUrl: "https://github.com/me/pilot.git", branch: "agent/T-2" },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(adapter.calls).toEqual(["delete agent/T-2"]);
    expect(lines.filter((l) => /not a branch of a spec/.test(l))).toHaveLength(
      3,
    );
  });

  it("does the rest when one step fails, then fails as an infrastructure problem so the job is tried again", async () => {
    const adapter = recorder({
      closePullRequest: async () => {
        throw new HostError("GitHub answered 503 closing pull request 7", 503);
      },
    });
    await expect(
      runHostTask({ adapter, repoRef: ref }, cleanup(), log),
    ).rejects.toThrow(InfrastructureError);
    expect(adapter.calls).toEqual([
      "delete spec/export",
      "delete agent/T-1",
      "delete agent/S-1-final",
    ]);
  });
});

describe("a repo-access task", () => {
  const adapter = {
    openPullRequest: async () => info(1),
    getPullRequest: async () => info(1),
    ...noCleanup,
  } as HostAdapter;
  const task = {
    kind: "repo-access" as const,
    repoUrl: "https://github.com/me/pilot.git",
  };

  it("reports what the check of the App found, for the repo the task names", async () => {
    const asked: unknown[] = [];
    const result = await runHostTask(
      {
        adapter,
        checkAccess: async (repo) => {
          asked.push(repo);
          return {
            state: "not-installed",
            fixUrl: "https://github.com/settings/installations/7",
          };
        },
      },
      task,
      log,
    );
    expect(asked).toEqual([{ owner: "me", name: "pilot" }]);
    expect(result).toEqual({
      stage: "repo-access",
      state: "not-installed",
      fixUrl: "https://github.com/settings/installations/7",
    });
  });

  it("fails the job when GitHub cannot be asked", async () => {
    const failing = runHostTask(
      {
        adapter,
        checkAccess: async () => {
          throw new HostError("GitHub did not describe the App: HTTP 502", 502);
        },
      },
      task,
      log,
    );
    await expect(failing).rejects.toBeInstanceOf(InfrastructureError);
    await expect(failing).rejects.toThrow("HTTP 502");
  });
});
