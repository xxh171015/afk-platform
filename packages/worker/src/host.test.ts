import { generateKeyPairSync } from "node:crypto";
import type { HostAdapter, PullRequestInfo } from "@afk/host";
import {
  createAppTokenSource,
  createGitHubAdapter,
  createGitLabAdapter,
  HostError,
  hostRepoRef,
} from "@afk/host";
import { FakeGitHub, FakeGitLab } from "@afk/host/testing";
import { git, gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import {
  AUTO_IMPROVEMENT_MERGE_NOTE,
  AUTO_MERGED_MARK,
  AUTO_MERGED_NOTE,
  AUTO_MERGED_SECTION,
  type HostTask,
  wrapMergeNote,
} from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
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
  mergedBy: null,
  mergedAt: null,
  mergedByPlatform: false,
  conflictsWithDefault: false,
  mergeSha: null,
  squashSha: null,
  humanComments: 0,
  ...extra,
});
const ref = () => ({ owner: "me", name: "pilot" });
// the parts of the host these tests do not use
const noCleanup = {
  markReady: async (): Promise<PullRequestInfo> => {
    throw new Error("not used");
  },
  markDraft: async (): Promise<PullRequestInfo> => {
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
  mergePullRequest: async () => {
    throw new Error("not used");
  },
  getBranchSha: async () => {
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

describe("a pr-draft task", () => {
  const task = {
    kind: "pr-draft" as const,
    pull: { id: 4, repoUrl: "https://github.com/me/pilot.git", number: 9 },
  };

  it("turns the pull request draft and reports what the host says now", async () => {
    const calls: unknown[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(1),
      getPullRequest: async () => info(9),
      markDraft: async (input) => {
        calls.push(input);
        return info(9, { draft: true });
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(calls).toEqual([{ repo: ref(), number: 9 }]);
    expect(result).toEqual({ stage: "pr-draft", ...info(9, { draft: true }) });
  });

  it("fails as an infrastructure problem when the host refuses, so the job is tried again", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(1),
      getPullRequest: async () => info(9),
      markDraft: async () => {
        throw new HostError(
          "GitHub refused to mark pull request 9 draft (403)",
          403,
        );
      },
    };
    await expect(
      runHostTask({ adapter, repoRef: ref }, task, log),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe("an auto-merge task", () => {
  const task = {
    kind: "auto-merge" as const,
    repoUrl: "https://github.com/me/pilot.git",
    number: 7,
    expectedHeadSha: "sha-from-job",
    section: AUTO_MERGED_SECTION,
  };

  it("replaces the marked merge-note, keeps what a person wrote outside, then merges at the job's head SHA", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const merges: unknown[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () =>
        `Spec: S-1\n\n${wrapMergeNote(AUTO_IMPROVEMENT_MERGE_NOTE)}\n\nI added a note`,
      updatePullRequestBody: async ({ body }) => {
        calls.push("update");
        writes.push(body);
      },
      mergePullRequest: async (input) => {
        calls.push("merge");
        merges.push(input);
        return info(7, { state: "merged", headSha: "sha-from-job" });
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(calls).toEqual(["update", "merge"]);
    expect(writes[0]).toContain("Spec: S-1");
    expect(writes[0]).toContain("I added a note");
    expect(writes[0]).toContain(AUTO_MERGED_MARK);
    expect(writes[0]).toContain(AUTO_MERGED_NOTE);
    expect(writes[0]).not.toContain(AUTO_IMPROVEMENT_MERGE_NOTE);
    expect(merges).toEqual([
      { repo: ref(), number: 7, expectedHeadSha: "sha-from-job" },
    ]);
    expect(result).toEqual({ stage: "auto-merge", outcome: "merged" });
  });

  it("reports failed with the host's reason when merge throws HostError, and does not treat it as infrastructure", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () =>
        wrapMergeNote(AUTO_IMPROVEMENT_MERGE_NOTE),
      updatePullRequestBody: async () => {},
      mergePullRequest: async () => {
        throw new HostError("GitHub answered 403 merging pull request 7", 403);
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(result).toEqual({
      stage: "auto-merge",
      outcome: "failed",
      reason: "GitHub answered 403 merging pull request 7",
    });
  });

  it("reports failed, without merging, when the description cannot be updated", async () => {
    const calls: string[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () =>
        wrapMergeNote(AUTO_IMPROVEMENT_MERGE_NOTE),
      updatePullRequestBody: async () => {
        throw new TypeError("fetch failed");
      },
      mergePullRequest: async () => {
        calls.push("merge");
        return info(7, { state: "merged" });
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(calls).toEqual([]);
    expect(result).toEqual({
      stage: "auto-merge",
      outcome: "failed",
      reason:
        "could not update the pull request description: TypeError: fetch failed",
    });
  });

  it("reports failed and puts the old description back when the merge fails for any reason", async () => {
    const original = `Spec: S-1\n\n${wrapMergeNote(AUTO_IMPROVEMENT_MERGE_NOTE)}`;
    const writes: string[] = [];
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7),
      getPullRequestBody: async () => original,
      updatePullRequestBody: async ({ body }) => {
        writes.push(body);
      },
      mergePullRequest: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const result = await runHostTask({ adapter, repoRef: ref }, task, log);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(original);
    expect(result).toEqual({
      stage: "auto-merge",
      outcome: "failed",
      reason: "could not merge the pull request: TypeError: fetch failed",
    });
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
    expect(result).toEqual({
      stage: "open-pr",
      outcome: "opened",
      ...info(7),
      hostChecks: [],
    });
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

  it("opens a pull request onto master through the GitLab adapter", async () => {
    const gitlab = new FakeGitLab({
      owner: "xuxinghua",
      repo: "afk-pilot-backend",
      token: "glpat-test",
    });
    await gitlab.start();
    try {
      const adapter = createGitLabAdapter({
        apiUrl: gitlab.url,
        tokens: { tokenFor: async () => "glpat-test" },
      });
      const result = await runHostTask(
        { adapter, repoRef: hostRepoRef },
        {
          kind: "open-pr",
          repoUrl: "https://gitlab.example/xuxinghua/afk-pilot-backend.git",
          base: "master",
          head: "spec/s-1",
          title: "S-1 Export",
          body: "Spec: S-1",
          draft: true,
        },
        log,
      );
      expect(result).toMatchObject({
        stage: "open-pr",
        outcome: "opened",
        number: 1,
        draft: true,
        state: "open",
      });
      expect(gitlab.mergeRequests()[0]).toMatchObject({
        source: "spec/s-1",
        target: "master",
        title: "Draft: S-1 Export",
      });
    } finally {
      await gitlab.stop();
    }
  });

  it("returns only the hostChecks whose paths the integration branch changed, with those files", async () => {
    const repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "commands:",
        '  - { name: test, run: "true", timeoutSeconds: 30 }',
        "hostChecks:",
        '  - paths: ["scripts/**"]',
        "    run: pnpm test packages/cli/src/up-sh.test.ts",
        "    why: host scripts need a Mac run",
        '  - paths: ["deploy/**"]',
        "    run: ./deploy/smoke.sh",
        "    why: deploy scripts run on the host",
        "",
      ].join("\n"),
      "src/app.ts": "v1\n",
      "scripts/up.sh": "echo v1\n",
      "deploy/smoke.sh": "echo v1\n",
    });
    try {
      git(repo.dir, ["checkout", "--quiet", "-b", "spec/export"]);
      repo.commit(
        {
          "src/app.ts": "v2\n",
          "scripts/up.sh": "echo v2\n",
        },
        "touch a host script and an undeclared file",
      );
      const adapter: HostAdapter = {
        ...noCleanup,
        openPullRequest: async () => info(7),
        getPullRequest: async () => info(7),
      };
      const result = await runHostTask(
        { adapter, repoRef: ref, repoDir: repo.dir },
        { ...open, head: "spec/export" },
        log,
      );
      expect(result.hostChecks).toEqual([
        {
          run: "pnpm test packages/cli/src/up-sh.test.ts",
          why: "host scripts need a Mac run",
          files: ["scripts/up.sh"],
        },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("returns an empty hostChecks list when the gate config declares none", async () => {
    const repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "commands:",
        '  - { name: test, run: "true", timeoutSeconds: 30 }',
        "",
      ].join("\n"),
      "src/app.ts": "v1\n",
      "scripts/up.sh": "echo v1\n",
    });
    try {
      git(repo.dir, ["checkout", "--quiet", "-b", "spec/export"]);
      repo.commit(
        {
          "src/app.ts": "v2\n",
          "scripts/up.sh": "echo v2\n",
        },
        "change files with no hostChecks declared",
      );
      const adapter: HostAdapter = {
        ...noCleanup,
        openPullRequest: async () => info(8),
        getPullRequest: async () => info(8),
      };
      const result = await runHostTask(
        { adapter, repoRef: ref, repoDir: repo.dir },
        { ...open, head: "spec/export" },
        log,
      );
      expect(result.hostChecks).toEqual([]);
    } finally {
      repo.cleanup();
    }
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

  it("passes merge and squash SHAs through in the sync result", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async ({ number }) =>
        number === 1
          ? info(1, { state: "merged", mergeSha: "d".repeat(40) })
          : info(2, { state: "merged", squashSha: "e".repeat(40) }),
    };
    const result = await runHostTask({ adapter, repoRef: ref }, sync, log);
    expect(result).toMatchObject({
      stage: "host-sync",
      pulls: [
        { id: 1, state: "merged", mergeSha: "d".repeat(40), squashSha: null },
        { id: 2, state: "merged", mergeSha: null, squashSha: "e".repeat(40) },
      ],
    });
  });

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
          mergedBy: null,
          mergedAt: null,
          mergedByPlatform: false,
          conflictsWithDefault: false,
          mergeSha: null,
          squashSha: null,
          humanComments: 0,
        },
        {
          id: 2,
          state: "merged",
          draft: false,
          headSha: "sha2",
          ci: "pending",
          review: "none",
          mergedBy: null,
          mergedAt: null,
          mergedByPlatform: false,
          conflictsWithDefault: false,
          mergeSha: null,
          squashSha: null,
          humanComments: 0,
        },
      ],
      defaults: [],
    });
  });

  it("passes on the human comment count", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1, { humanComments: 3 }),
    };
    const result = await runHostTask(
      { adapter, repoRef: ref },
      { kind: "host-sync", pulls: [{ id: 1, repoUrl: "u", number: 1 }] },
      log,
    );
    expect(result).toMatchObject({
      pulls: [{ id: 1, humanComments: 3 }],
    });
  });

  it("passes on a conflict with the default branch", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1, { conflictsWithDefault: true }),
    };
    const result = await runHostTask(
      { adapter, repoRef: ref },
      { kind: "host-sync", pulls: [{ id: 1, repoUrl: "u", number: 1 }] },
      log,
    );
    expect(result).toMatchObject({
      pulls: [{ id: 1, conflictsWithDefault: true }],
    });
  });

  it("reads each default branch and reports its sha", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1),
      getBranchSha: async ({ branch }) => `sha-of-${branch}`,
    };
    const result = await runHostTask(
      { adapter, repoRef: ref },
      {
        kind: "host-sync",
        pulls: [],
        defaults: [
          { repoUrl: "https://github.com/me/pilot.git", branch: "main" },
        ],
      },
      log,
    );
    expect(result).toEqual({
      stage: "host-sync",
      pulls: [],
      defaults: [
        { repoUrl: "https://github.com/me/pilot.git", sha: "sha-of-main" },
      ],
    });
  });

  it("omits a default branch it could not read and still reports the others", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1),
      getBranchSha: async ({ branch }) => {
        if (branch === "main") throw new HostError("GitHub answered 502", 502);
        return `sha-of-${branch}`;
      },
    };
    const result = (await runHostTask(
      { adapter, repoRef: ref },
      {
        kind: "host-sync",
        pulls: [],
        defaults: [
          { repoUrl: "https://github.com/me/a.git", branch: "main" },
          { repoUrl: "https://github.com/me/b.git", branch: "develop" },
        ],
      },
      log,
    )) as { defaults: Record<string, unknown>[] };
    expect(result.defaults).toEqual([
      { repoUrl: "https://github.com/me/b.git", sha: "sha-of-develop" },
    ]);
  });

  it("reads each idle ticket branch and reports its sha", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1),
      getBranchSha: async ({ branch }) => `sha-of-${branch}`,
    };
    const result = await runHostTask(
      { adapter, repoRef: ref },
      {
        kind: "host-sync",
        pulls: [],
        ticketBranches: [
          {
            ticketId: 1,
            repoUrl: "https://github.com/me/a.git",
            branch: "agent/T-1",
          },
        ],
      } as HostTask,
      log,
    );
    expect(result).toEqual({
      stage: "host-sync",
      pulls: [],
      defaults: [],
      ticketBranches: [{ ticketId: 1, sha: "sha-of-agent/T-1" }],
    });
  });

  it("omits a ticket branch it could not read and still reports the others", async () => {
    const adapter: HostAdapter = {
      ...noCleanup,
      openPullRequest: async () => info(0),
      getPullRequest: async () => info(1),
      getBranchSha: async ({ branch }) => {
        if (branch === "agent/T-1")
          throw new HostError("GitHub answered 404", 404);
        return `sha-of-${branch}`;
      },
    };
    const result = (await runHostTask(
      { adapter, repoRef: ref },
      {
        kind: "host-sync",
        pulls: [],
        ticketBranches: [
          {
            ticketId: 1,
            repoUrl: "https://github.com/me/a.git",
            branch: "agent/T-1",
          },
          {
            ticketId: 2,
            repoUrl: "https://github.com/me/b.git",
            branch: "agent/T-2",
          },
        ],
      } as HostTask,
      log,
    )) as { ticketBranches: Record<string, unknown>[] };
    expect(result.ticketBranches).toEqual([
      { ticketId: 2, sha: "sha-of-agent/T-2" },
    ]);
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

  it("fails the look when GitLab answers 429, so the next round can wait", async () => {
    const gitlab = new FakeGitLab({
      owner: "xuxinghua",
      repo: "afk-pilot-backend",
      token: "glpat-test",
    });
    await gitlab.start();
    try {
      const adapter = createGitLabAdapter({
        apiUrl: gitlab.url,
        tokens: { tokenFor: async () => "glpat-test" },
      });
      await adapter.openPullRequest({
        repo: {
          owner: "xuxinghua",
          name: "afk-pilot-backend",
          host: "gitlab.example",
        },
        head: "spec/s-1",
        base: "master",
        title: "S-1",
        body: "",
      });
      gitlab.rateLimitSeconds = 12;
      const error = await runHostTask(
        { adapter, repoRef: hostRepoRef },
        {
          kind: "host-sync",
          pulls: [
            {
              id: 1,
              repoUrl: "https://gitlab.example/xuxinghua/afk-pilot-backend.git",
              number: 1,
            },
          ],
        },
        log,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(InfrastructureError);
      expect(error).toMatchObject({
        message: "GitLab answered 429; retry after 12s",
      });
    } finally {
      await gitlab.stop();
    }
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
      mergePullRequest: async () => info(0),
      markReady: async () => info(0),
      markDraft: async () => info(0),
      closePullRequest: async ({ number }) => {
        calls.push(`close ${number}`);
        return info(number, { state: "closed" });
      },
      deleteBranch: async ({ branch }) => {
        calls.push(`delete ${branch}`);
        return "deleted";
      },
      getBranchSha: async () => {
        throw new Error("not used");
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

  it("deletes local orphan refs of the spec's branches", async () => {
    const repo = makeRepo();
    const branch = "agent/T-1";
    gitOrThrow(repo.dir, ["branch", branch]);
    const sha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const orphan = `refs/afk/orphan/${branch}/${sha}`;
    gitOrThrow(repo.dir, ["update-ref", orphan, sha]);
    try {
      await runHostTask(
        { adapter: recorder(), repoRef: ref, localRepos: [repo.dir] },
        cleanup({
          pulls: [],
          branches: [{ repoUrl: "https://github.com/me/pilot.git", branch }],
        }),
        log,
      );
      expect(
        git(repo.dir, ["show-ref", "--verify", "--quiet", orphan]).code,
      ).not.toBe(0);
    } finally {
      repo.cleanup();
    }
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

  it("deletes this spec's update branch on the host and leaves another spec's branches", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const github = new FakeGitHub({
      appId: "1",
      installationId: "2",
      publicKey,
      owner: "me",
      repo: "pilot",
    });
    await github.start();
    try {
      github.addBranch("spec/a1b2c3/export");
      github.addBranch("agent/a1b2c3/T-1");
      github.addBranch("agent/a1b2c3/S-1-final");
      github.addBranch("agent/a1b2c3/S-1-update");
      github.addBranch("spec/a1b2c3/other");
      github.addBranch("agent/a1b2c3/T-99");
      const adapter = createGitHubAdapter({
        apiUrl: github.url,
        tokens: createAppTokenSource({
          credentials: { appId: "1", installationId: "2", privateKey },
          apiUrl: github.url,
        }),
      });
      const repoUrl = "https://github.com/me/pilot.git";
      await runHostTask(
        { adapter, repoRef: ref },
        cleanup({
          pulls: [],
          branches: [
            { repoUrl, branch: "spec/a1b2c3/export" },
            { repoUrl, branch: "agent/a1b2c3/T-1" },
            { repoUrl, branch: "agent/a1b2c3/S-1-final" },
            { repoUrl, branch: "agent/a1b2c3/S-1-update" },
          ],
        }),
        log,
      );
      expect(github.branches()).toEqual([
        "agent/a1b2c3/T-99",
        "spec/a1b2c3/other",
      ]);
    } finally {
      await github.stop();
    }
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

  it("asks for read-only access when the repo is a reference repo", async () => {
    const asked: unknown[] = [];
    const result = await runHostTask(
      {
        adapter,
        checkAccess: async (repo, mode) => {
          asked.push({ repo, mode });
          return {
            state: "ok",
            files: { gates: false, integrationCompose: false },
          };
        },
      },
      { ...task, reference: true },
      log,
    );
    expect(asked).toEqual([
      {
        repo: { owner: "me", name: "pilot" },
        mode: { readOnly: true },
      },
    ]);
    expect(result).toMatchObject({ stage: "repo-access", state: "ok" });
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

describe("an index-pr-links task", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  const task = (extra: {
    mergeSha?: string | null;
    squashSha?: string | null;
  }): HostTask => ({
    kind: "index-pr-links",
    repoUrl: "https://github.com/me/pilot.git",
    repoName: "pilot",
    defaultBranch: "main",
    number: 7,
    mergeSha: extra.mergeSha ?? null,
    squashSha: extra.squashSha ?? null,
  });

  function adapterWithBody(body: string): HostAdapter {
    return {
      ...noCleanup,
      openPullRequest: async () => info(7),
      getPullRequest: async () => info(7, { state: "merged" }),
      getPullRequestBody: async () => body,
    };
  }

  it("does not clone inside host-sync: it needs a default-branch clone of its own", async () => {
    await expect(
      runHostTask(
        { adapter: adapterWithBody(""), repoRef: ref },
        task({ mergeSha: "d".repeat(40) }),
        log,
      ),
    ).rejects.toThrow("index-pr-links needs a clone of the default branch");
  });

  it("walks commits a merge brought onto the default branch and reads their trailers", async () => {
    repo = makeRepo();
    git(repo.dir, ["checkout", "--quiet", "-b", "pr"]);
    const first = repo.commit(
      { "a.ts": "a\n" },
      "first\n\nSpec: S-1\nTicket: T-1\nRun: R-10",
    );
    const second = repo.commit(
      { "b.ts": "b\n" },
      "second\n\nSpec: S-1\nTicket: T-2\nRun: R-11",
    );
    git(repo.dir, ["checkout", "--quiet", "main"]);
    gitOrThrow(repo.dir, ["merge", "--no-ff", "-m", "Merge PR", "pr"]);
    const mergeSha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const result = await runHostTask(
      { adapter: adapterWithBody(""), repoRef: ref, repoDir: repo.dir },
      task({ mergeSha }),
      log,
    );
    expect(result).toEqual({
      stage: "index-pr-links",
      links: [
        { sha: first, spec: "S-1", ticket: "T-1", run: "R-10" },
        { sha: second, spec: "S-1", ticket: "T-2", run: "R-11" },
      ],
    });
  });

  it("for a squash, takes Spec from the pull request body and records no Ticket", async () => {
    repo = makeRepo();
    git(repo.dir, ["checkout", "--quiet", "-b", "pr"]);
    repo.commit({ "a.ts": "a\n" }, "work\n\nSpec: S-1\nTicket: T-1\nRun: R-10");
    git(repo.dir, ["checkout", "--quiet", "main"]);
    gitOrThrow(repo.dir, ["merge", "--squash", "pr"]);
    gitOrThrow(repo.dir, [
      "commit",
      "--quiet",
      "-m",
      "squash\n\nSpec: S-1\nTicket: T-1",
    ]);
    const squashSha = gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);
    const result = await runHostTask(
      {
        adapter: adapterWithBody("Spec: S-1\n\n## Tickets\n- T-1 work"),
        repoRef: ref,
        repoDir: repo.dir,
      },
      task({ squashSha }),
      log,
    );
    expect(result).toEqual({
      stage: "index-pr-links",
      links: [{ sha: squashSha, spec: "S-1", ticket: null, run: null }],
    });
  });
});
