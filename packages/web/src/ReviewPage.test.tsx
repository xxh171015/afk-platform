// @vitest-environment jsdom
import {
  CHANGE_REQUEST_IN_REWORK,
  changeRequestPartiallyMergedMessage,
  staleChangeRequestPrompt,
} from "@afk/shared";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkbench,
  fakeServer,
  type Handler,
  renderApp,
} from "./test-utils.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);
const NEW_HEAD = "d".repeat(40);

const openPr = {
  order: 1,
  waitsFor: [] as string[],
  repo: "backend",
  number: 7,
  url: "https://github.com/me/shop/pull/7",
  state: "open" as const,
  draft: false,
  ci: "success" as const,
  review: "none" as const,
  syncError: null,
};

function specView(over: Record<string, unknown> = {}) {
  return {
    spec: {
      id: 1,
      displayId: "S-1",
      slug: "order-export",
      title: "Order export",
      type: "feature",
      body: "## User Stories\n\n1. As a merchant, I want to export orders.\n",
      state: "awaiting-review",
      pauseReason: null,
      integrationBranches: [],
      warnings: [],
      repos: [
        {
          name: "backend",
          url: "https://github.com/me/shop.git",
          hostKind: "github",
        },
      ],
      ...(over.spec as object | undefined),
    },
    tickets: over.tickets ?? [
      {
        id: 1,
        displayId: "T-1",
        specId: 1,
        specDisplayId: "S-1",
        title: "Export API",
        type: "implementation",
        state: "done",
        blockedReason: null,
        repo: "backend",
        refs: [],
        environment: [],
        appended: false,
        brief: null,
      },
    ],
    edges: over.edges ?? [],
    finalizations: [],
    mergeOrder: over.mergeOrder ?? {
      ordered: ["backend"],
      after: {},
      unordered: [],
    },
    orderBroken: [],
    pullRequests: over.pullRequests ?? [openPr],
    acceptancePack: over.acceptancePack ?? null,
    timeline: [],
    timelineLegacy: false,
    finalRuns: [],
    potentialConflicts: [],
    leadTime: null,
    usageByStage: [],
    links: [],
    autoMerge: over.autoMerge,
  };
}

function specReview(over: Record<string, unknown> = {}) {
  return {
    spec: {
      id: 1,
      displayId: "S-1",
      title: "Order export",
      type: "feature",
      state: "awaiting-review",
      ...(over.spec as object | undefined),
    },
    userStories: [
      { number: 1, text: "As a merchant, I want to export orders." },
    ],
    pullRequests: over.pullRequests ?? [
      {
        id: 7,
        repo: "backend",
        number: 12,
        url: "https://github.com/me/shop/pull/12",
        state: "open",
        draft: false,
        ci: "success",
        review: "none",
        headSha: SHA,
        conflictsWithDefault: false,
        humanComments: 0,
        reviewNoteError:
          (over.reviewNoteError as string | null | undefined) ?? null,
        revision: {
          id: 3,
          state: "ready",
          complete: true,
          filesCount: 3,
          additions: 8,
          deletions: 2,
          viewedCount: 1,
          commentCount: 0,
          error: null,
          ...((over.revision as object | undefined) ?? {}),
        },
      },
    ],
    acceptancePack: over.acceptancePack ?? {
      generatedAt: "2026-11-20T00:00:00.000Z",
      mergeOrder: { ordered: ["backend"], after: {}, unordered: [] },
      orderBroken: [],
      repos: [
        {
          repo: "backend",
          pullRequest: {
            order: 1,
            waitsFor: [],
            repo: "backend",
            number: 12,
            url: "https://github.com/me/shop/pull/12",
            state: "open",
            draft: false,
            ci: "success",
            review: "none",
            syncError: null,
          },
          gate: null,
          flakyTests: [],
          tickets: [
            {
              displayId: "T-1",
              title: "Export API",
              appended: false,
              criteria: [
                {
                  text: "export works",
                  tests: ["export.test.ts"],
                  status: "unverified",
                  reason: "not in the JUnit report: export.test.ts",
                },
              ],
            },
          ],
          findings: [
            {
              ticket: "T-1",
              run: "R-10",
              stage: "review",
              kind: "must-fix",
              body: "handle empty export",
              resolution: "fixed",
              axis: "spec",
            },
          ],
          scopeCreep: [
            { ticket: "T-1", run: "R-10", body: "renamed a helper" },
          ],
          reviewUncertainties: [],
          resolvedUncertainties: [],
          decisions: [],
          protectedPathApprovals: [],
          standardsSources: [],
        },
      ],
      cancelledTickets: [],
      agentSeconds: 12,
      needsDecision: [
        {
          kind: "needs-human",
          id: "R-10#0",
          source: "T-1",
          text: "which format?",
        },
      ],
    },
    autoMerge: over.autoMerge ?? {
      policy: "manual",
      willMerge: false,
      mergeAt: null,
      reason: null,
      event: null,
    },
    tickets: over.tickets ?? [
      {
        id: 1,
        displayId: "T-1",
        title: "Export API",
        stories: [1],
        criteria: [
          {
            text: "export works",
            tests: ["export.test.ts"],
            status: "unverified",
            reason: "not in the JUnit report: export.test.ts",
          },
        ],
      },
      {
        id: 2,
        displayId: "T-2",
        title: "Export UI",
        stories: [1],
        criteria: [
          {
            text: "button works",
            tests: ["ui.test.ts"],
            status: "verified",
            reason: null,
          },
        ],
      },
    ],
    findings: over.findings ?? [
      {
        ticket: "T-1",
        run: "R-10",
        stage: "review",
        kind: "must-fix",
        body: "handle empty export",
        resolution: "fixed",
        axis: "spec",
      },
    ],
  };
}

function aFile(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    oldBlob: SHA2,
    newBlob: SHA3,
    additions: 2,
    deletions: 1,
    binary: false,
    generated: false,
    test: false,
    lockfile: false,
    patchOmitted: null,
    attributions: [{ ticket: "T-1" }],
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        owners: [{ ticket: "T-1", lines: 2 }],
      },
    ],
    viewed: false,
    ...over,
  };
}

function readyRevision(over: Record<string, unknown> = {}) {
  return {
    state: "ready" as const,
    id: 3,
    headSha: SHA,
    baseSha: SHA2,
    mergeBaseSha: SHA2,
    previousHeadSha: SHA2,
    updateBranchSincePrevious: false,
    complete: true,
    omittedReason: null,
    filesCount: 3,
    additions: 8,
    deletions: 2,
    files: [
      aFile(),
      aFile({
        id: 12,
        path: "src/a.test.ts",
        test: true,
        viewed: true,
        attributions: [{ ticket: "T-1" }, { ticket: "T-2" }],
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            owners: [{ ticket: "T-1", lines: 1 }],
          },
          {
            oldStart: 8,
            oldLines: 1,
            newStart: 9,
            newLines: 2,
            owners: [{ ticket: "T-2", lines: 2 }],
          },
        ],
      }),
      aFile({
        id: 13,
        path: "pnpm-lock.yaml",
        lockfile: true,
        additions: 40,
        deletions: 2,
        attributions: [{ kind: "setup" }],
        hunks: null,
      }),
    ],
    ...over,
  };
}

function aGuide(over: Record<string, unknown> = {}) {
  return {
    revisionId: 3,
    unattributedCount: 0,
    spec: {
      id: 1,
      displayId: "S-1",
      title: "Order export",
      type: "feature",
      userStories: [
        { number: 1, text: "As a merchant, I want to export orders." },
      ],
      sourceSpec: null,
    },
    tickets: [
      {
        id: 1,
        displayId: "T-1",
        title: "Export API",
        appended: false,
        stories: [
          { number: 1, text: "As a merchant, I want to export orders." },
        ],
        criteria: [
          {
            text: "export works",
            tests: ["export.test.ts"],
            status: "unverified",
            reason: "not in the JUnit report: export.test.ts",
          },
        ],
        summaries: [
          {
            run: "R-10",
            stage: "implement",
            summary: "added the export endpoint",
          },
        ],
        decisions: [],
        rulings: [],
        hunks: [
          {
            fileId: 11,
            path: "src/a.ts",
            newStart: 1,
            newLines: 2,
            oldStart: 1,
            oldLines: 1,
            lines: 2,
          },
        ],
        viewed: false,
      },
    ],
    otherRepoTickets: [],
    wrapUp: [],
    changeRequests: [],
    setup: [],
    planning: [],
    unattributed: [],
    ...over,
  };
}

function patches(): Record<string, Handler> {
  return {
    "GET /review-files/11": ({ url }) => ({
      json: {
        id: 11,
        path: "src/a.ts",
        view: url.searchParams.get("view") === "since" ? "since" : "all",
        patch:
          url.searchParams.get("view") === "since"
            ? "@@ -1 +1,2 @@\n-old\n+new-a\n+extra\n"
            : "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
        patchOmitted: null,
      },
    }),
    "GET /review-files/12": ({ url }) => ({
      json: {
        id: 12,
        path: "src/a.test.ts",
        view: url.searchParams.get("view") === "since" ? "since" : "all",
        patch:
          "@@ -1 +1 @@\n-old test\n+new test\n@@ -8 +9,2 @@\n-ui\n+ui-a\n+ui-b\n",
        patchOmitted: null,
      },
    }),
    "GET /review-files/13": () => ({
      json: {
        id: 13,
        path: "pnpm-lock.yaml",
        view: "all",
        patch: "@@ -1 +1 @@\n-lock\n+lock2\n",
        patchOmitted: null,
      },
    }),
  };
}

function aComment(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    displayId: "C-1",
    specId: 1,
    pullRequestId: 7,
    revisionId: 3,
    path: "src/a.ts",
    side: "new" as const,
    lineStart: 1,
    lineEnd: 1,
    excerpt: "b",
    body: "empty list should return 200",
    state: "draft" as const,
    changeRequestId: null,
    reply: null,
    reworkRunId: null,
    writtenOn: SHA,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...over,
  };
}

function reviewServer(
  over: {
    spec?: Record<string, unknown>;
    review?: Record<string, unknown>;
    revision?: Record<string, unknown>;
    comments?: Record<string, unknown>[];
    guide?: Record<string, unknown>;
    routes?: Record<string, Handler>;
  } = {},
) {
  const revision = readyRevision(over.revision);
  let comments = [...(over.comments ?? [])];
  return fakeServer({
    "GET /workbench": () => ({ json: emptyWorkbench }),
    "GET /search": () => ({ json: { specs: [], tickets: [] } }),
    "GET /specs/1": () => ({ json: specView(over.spec) }),
    "GET /specs/1/review": () => ({ json: specReview(over.review) }),
    "GET /review-revisions/3/guide": () => ({ json: aGuide(over.guide) }),
    "GET /pull-requests/7/review-revision": ({ url }) => {
      const head = url.searchParams.get("head");
      if (head && head !== SHA && head !== (revision.headSha as string)) {
        return {
          json: { state: "pending", id: null, headSha: head },
        };
      }
      return { json: { ...revision, headSha: head ?? SHA } };
    },
    "GET /pull-requests/7/review-comments": () => ({ json: { comments } }),
    "POST /specs/1/change-requests": ({ body }) => {
      const input = (body ?? {}) as { acknowledgeStale?: boolean };
      const drafts = comments.filter((row) => row.state === "draft");
      const stale = drafts
        .filter((row) => row.writtenOn !== SHA)
        .map((row) => ({
          displayId: row.displayId,
          writtenOn: row.writtenOn,
          currentHead: SHA,
        }));
      if (stale.length > 0 && !input.acknowledgeStale) {
        return {
          status: 409,
          json: { error: "有意见写在旧的审查版本上", stale },
        };
      }
      comments = comments.map((row) =>
        row.state === "draft" ? { ...row, state: "submitted" } : row,
      );
      return {
        json: {
          id: 1,
          number: 1,
          state: "active",
          comments: drafts.map((row) => row.displayId),
        },
      };
    },
    "POST /pull-requests/7/review-comments": ({ body }) => {
      const input = body as Record<string, unknown>;
      const created = aComment({
        id: comments.length + 1,
        displayId: `C-${comments.length + 1}`,
        ...input,
        state: "draft",
        changeRequestId: null,
        writtenOn: SHA,
      });
      comments = [...comments, created];
      return { status: 201, json: created };
    },
    "PATCH /review-comments/1": ({ body }) => {
      const input = body as { body: string };
      comments = comments.map((row) =>
        row.id === 1 ? { ...row, body: input.body } : row,
      );
      return { json: comments.find((row) => row.id === 1) };
    },
    "DELETE /review-comments/1": () => {
      comments = comments.filter((row) => row.id !== 1);
      return { json: { id: 1 } };
    },
    ...patches(),
    ...over.routes,
  });
}

function searchOf(router: {
  state: { location: { search: unknown; searchStr?: string; href?: string } };
}) {
  const loc = router.state.location;
  const raw =
    typeof loc.searchStr === "string" && loc.searchStr
      ? loc.searchStr
      : typeof loc.search === "string"
        ? loc.search
        : loc.href?.includes("?")
          ? loc.href.slice(loc.href.indexOf("?"))
          : "";
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const search = loc.search;
  if (search && typeof search === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(
      search as Record<string, unknown>,
    )) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `?${decodeURIComponent(text)}` : "";
  }
  return "";
}

describe("the spec review page", () => {
  it("opens at /specs/:id/review on the 导读 shell and keeps 全部变更 available", async () => {
    const { router } = renderApp(reviewServer(), "/specs/1/review");
    expect(await screen.findByTestId("review-page")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "审查" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      await screen.findByRole("button", { name: "导读", pressed: true }),
    ).toBeTruthy();
    expect(await screen.findByTestId("review-guide")).toBeTruthy();
    expect(screen.getByText("需求在做什么")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /T-1 Export API/ }),
    ).toBeTruthy();
    expect(screen.getByText("已看 1/3")).toBeTruthy();
    expect(screen.getByText(SHA.slice(0, 7))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部变更" }));
    await waitFor(() => expect(searchOf(router)).toMatch(/view=all/));
    expect((await screen.findAllByText("src/a.ts")).length).toBeGreaterThan(0);
    expect(screen.getByText("+b")).toBeTruthy();
    expect(screen.getByText(/已折叠/)).toBeTruthy();
  });

  it("lists a Change request under 修改要求, not under 收尾", async () => {
    renderApp(
      reviewServer({
        guide: {
          wrapUp: [
            {
              stage: "final-fix",
              summaries: [{ run: "R-8", stage: "final-fix", summary: "nits" }],
              hunks: [],
              viewed: false,
            },
          ],
          changeRequests: [
            {
              number: 1,
              comments: [
                {
                  displayId: "C-12",
                  body: "empty list should return 200 and []",
                },
              ],
              dispositions: [
                {
                  displayId: "C-12",
                  result: "addressed：returns 200 with []",
                },
              ],
              hunks: [
                {
                  path: "src/a.ts",
                  newStart: 12,
                  newLines: 1,
                },
              ],
            },
          ],
        },
      }),
      "/specs/1/review",
    );
    await screen.findByTestId("review-guide");
    expect(screen.getByRole("heading", { name: "修改要求" })).toBeTruthy();
    expect(screen.getByText("修改要求 #1")).toBeTruthy();
    expect(
      screen.getByText("C-12：empty list should return 200 and []"),
    ).toBeTruthy();
    expect(
      screen.getByText("C-12：addressed：returns 200 with []"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "跳到 src/a.ts +12,1" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "收尾" })).toBeTruthy();
    expect(screen.getByText("终审修复")).toBeTruthy();
    expect(screen.queryByText("返工")).toBeNull();
  });

  it("notes update-branch at the top of 上次审后 when default-branch commits landed in between", async () => {
    renderApp(
      reviewServer({
        revision: { updateBranchSincePrevious: true },
      }),
      "/specs/1/review?view=since",
    );
    expect(
      await screen.findByText(
        "与上次审查版本对照。中间合过默认分支（update-branch），会含那些改动。",
      ),
    ).toBeTruthy();
  });

  it("does not mention update-branch on 上次审后 when none ran in between", async () => {
    renderApp(reviewServer(), "/specs/1/review?view=since");
    expect(await screen.findByText("与上次审查版本对照。")).toBeTruthy();
    expect(screen.queryByText(/中间合过默认分支/)).toBeNull();
  });

  it("jumps from a guide hunk into the all-changes view", async () => {
    const { router } = renderApp(reviewServer(), "/specs/1/review");
    await screen.findByTestId("review-guide");
    fireEvent.click(screen.getByRole("button", { name: "跳到 src/a.ts +1,2" }));
    await waitFor(() => expect(searchOf(router)).toMatch(/view=all/));
    expect(searchOf(router)).toMatch(/file=src\/a.ts/);
    expect(await screen.findByText("+b")).toBeTruthy();
    expect(
      document.querySelector("[data-hunk='0'][data-current='true']"),
    ).toBeTruthy();
  });

  it("keeps filter tokens in q and still counts 已看 against every file", async () => {
    const { router } = renderApp(reviewServer(), "/specs/1/review?view=all");
    await screen.findAllByText("src/a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "未看" }));
    await waitFor(() => expect(searchOf(router)).toMatch(/unviewed/));
    expect(screen.getByText("已看 1/3")).toBeTruthy();
    expect(screen.getByText("当前显示 2 个")).toBeTruthy();
    expect(screen.queryByText("src/a.test.ts")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "过滤路径" }), {
      target: { value: "src/*.ts" },
    });
    await waitFor(() => expect(searchOf(router)).toMatch(/src\/\*\.ts/));
    expect(screen.getByText("当前显示 1 个")).toBeTruthy();
    expect(screen.getAllByText("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.queryByText("pnpm-lock.yaml")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "T-1" }));
    await waitFor(() => expect(searchOf(router)).toMatch(/ticket:T-1/));
  });

  it("groups a file under each ticket and only highlights that ticket's hunks", async () => {
    renderApp(reviewServer(), "/specs/1/review?view=all&file=src/a.test.ts");
    await screen.findAllByText("src/a.test.ts");
    fireEvent.click(screen.getByRole("button", { name: "按票" }));
    const t2 = screen.getByTestId("review-ticket-T-2");
    fireEvent.click(within(t2).getByRole("button", { name: "src/a.test.ts" }));
    expect(await screen.findByText("另有 1 段属于 T-1")).toBeTruthy();
    expect(screen.getByText("+ui-a")).toBeTruthy();
    expect(screen.queryByText("+new test")).toBeNull();
  });

  it("loads extra context from the stored blob without swapping the pinned head", async () => {
    const blobLines = Array.from({ length: 20 }, (_, i) => `ctx-${i + 1}`);
    const server = reviewServer({
      revision: {
        files: [
          aFile({
            hunks: [
              {
                oldStart: 21,
                oldLines: 1,
                newStart: 21,
                newLines: 2,
                owners: [{ ticket: "T-1", lines: 2 }],
              },
            ],
          }),
        ],
      },
      routes: {
        "GET /review-files/11": () => ({
          json: {
            id: 11,
            path: "src/a.ts",
            view: "all",
            patch: "@@ -21 +21,2 @@\n-a\n+b\n+c\n",
            patchOmitted: null,
          },
        }),
        [`GET /review-blobs/${SHA3}`]: ({ url }) => ({
          json: {
            sha: SHA3,
            from: Number(url.searchParams.get("from")),
            to: Number(url.searchParams.get("to")),
            stored: true,
            lines: blobLines.slice(
              Number(url.searchParams.get("from")) - 1,
              Number(url.searchParams.get("to")),
            ),
          },
        }),
      },
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    await screen.findByText("+b");
    fireEvent.click(screen.getByRole("button", { name: "向上展开 20 行" }));
    expect(await screen.findByText("ctx-1")).toBeTruthy();
    expect(
      server.calls.some((call) => call.startsWith("GET /review-blobs/")),
    ).toBe(true);
  });

  it("renders a large open file's hunks lazily and still expands context", async () => {
    const hunkCount = 12;
    const patch = Array.from({ length: hunkCount }, (_, i) => {
      const line = i * 20 + 1;
      return `@@ -${line} +${line} @@\n-old${i}\n+new${i}\n`;
    }).join("");
    const blobLines = Array.from({ length: 20 }, (_, i) => `ctx-${i + 1}`);
    const server = reviewServer({
      revision: {
        files: [
          aFile({
            hunks: Array.from({ length: hunkCount }, (_, i) => ({
              oldStart: i * 20 + 1,
              oldLines: 1,
              newStart: i * 20 + 1,
              newLines: 1,
              owners: [{ ticket: "T-1", lines: 1 }],
            })),
          }),
        ],
      },
      routes: {
        "GET /review-files/11": () => ({
          json: {
            id: 11,
            path: "src/a.ts",
            view: "all",
            patch,
            patchOmitted: null,
          },
        }),
        [`GET /review-blobs/${SHA3}`]: ({ url }) => ({
          json: {
            sha: SHA3,
            from: Number(url.searchParams.get("from")),
            to: Number(url.searchParams.get("to")),
            stored: true,
            lines: blobLines.slice(
              Number(url.searchParams.get("from")) - 1,
              Number(url.searchParams.get("to")),
            ),
          },
        }),
      },
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    expect(await screen.findByText("+new0")).toBeTruthy();
    expect(document.querySelectorAll("[data-hunk]").length).toBeLessThan(
      hunkCount,
    );
    expect(document.querySelector("[data-hunk='11']")).toBeNull();
    const firstHunk = document.querySelector("[data-hunk='0']");
    expect(firstHunk).toBeTruthy();
    fireEvent.click(
      within(firstHunk as HTMLElement).getByRole("button", {
        name: "向下展开 20 行",
      }),
    );
    expect(await screen.findByText("ctx-2")).toBeTruthy();
  });

  it("fills the gap to the next hunk from the stored blob", async () => {
    const blobLines = Array.from({ length: 40 }, (_, i) => `gap-${i + 1}`);
    const server = reviewServer({
      revision: {
        files: [
          aFile({
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 2,
                owners: [{ ticket: "T-1", lines: 2 }],
              },
              {
                oldStart: 40,
                oldLines: 1,
                newStart: 40,
                newLines: 1,
                owners: [{ ticket: "T-1", lines: 1 }],
              },
            ],
          }),
        ],
      },
      routes: {
        "GET /review-files/11": () => ({
          json: {
            id: 11,
            path: "src/a.ts",
            view: "all",
            patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n@@ -40 +40 @@\n-z\n+y\n",
            patchOmitted: null,
          },
        }),
        [`GET /review-blobs/${SHA3}`]: ({ url }) => ({
          json: {
            sha: SHA3,
            from: Number(url.searchParams.get("from")),
            to: Number(url.searchParams.get("to")),
            stored: true,
            lines: blobLines.slice(
              Number(url.searchParams.get("from")) - 1,
              Number(url.searchParams.get("to")),
            ),
          },
        }),
      },
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    await screen.findByText("+b");
    fireEvent.click(screen.getByRole("button", { name: "展开到下一个 hunk" }));
    expect(await screen.findByText("gap-3")).toBeTruthy();
    expect(screen.getByText("gap-39")).toBeTruthy();
  });

  it("marks a file viewed over HTTP from v and leaves j inert on other pages", async () => {
    let viewed = false;
    const server = reviewServer({
      routes: {
        "PUT /pull-requests/7/viewed-files/src/a.ts": () => {
          viewed = true;
          return { json: { viewed: true } };
        },
        "DELETE /pull-requests/7/viewed-files/src/a.ts": () => {
          viewed = false;
          return { json: { viewed: false } };
        },
      },
      revision: {
        files: [
          aFile({ viewed: false }),
          aFile({ id: 12, path: "src/a.test.ts", test: true, viewed: true }),
          aFile({ id: 13, path: "pnpm-lock.yaml", lockfile: true }),
        ],
      },
    });
    const { router } = renderApp(
      server,
      "/specs/1/review?view=all&file=src/a.ts",
    );
    await screen.findAllByText("src/a.ts");
    fireEvent.keyDown(window, { key: "v" });
    await waitFor(() =>
      expect(server.calls.some((call) => call.includes("/viewed-files/"))).toBe(
        true,
      ),
    );
    expect(viewed).toBe(true);
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(searchOf(router)).toMatch(/a\.test\.ts/));
    await router.navigate({
      to: "/specs/$specId/delivery",
      params: { specId: "1" },
    });
    expect(await screen.findByRole("heading", { name: "验收包" })).toBeTruthy();
    const before = router.state.location.pathname;
    fireEvent.keyDown(window, { key: "j" });
    expect(router.state.location.pathname).toBe(before);
  });

  it("shows a new-head banner without replacing the open diff until the person switches", async () => {
    let head = SHA;
    const server = reviewServer({
      review: {},
      routes: {
        "GET /specs/1/review": () => ({
          json: specReview({
            pullRequests: [
              {
                id: 7,
                repo: "backend",
                number: 12,
                url: "https://github.com/me/shop/pull/12",
                state: "open",
                draft: false,
                ci: "success",
                review: "none",
                headSha: head,
                conflictsWithDefault: false,
                humanComments: 0,
                revision: {
                  id: 3,
                  state: "ready",
                  complete: true,
                  filesCount: 3,
                  additions: 8,
                  deletions: 2,
                  viewedCount: 1,
                  commentCount: 0,
                  error: null,
                },
              },
            ],
          }),
        }),
        "GET /pull-requests/7/review-revision": ({ url }) => {
          const req = url.searchParams.get("head") ?? SHA;
          if (req === NEW_HEAD) {
            return {
              json: readyRevision({
                headSha: NEW_HEAD,
                files: [aFile({ path: "src/brand-new.ts", id: 99 })],
              }),
            };
          }
          return { json: readyRevision({ headSha: SHA }) };
        },
      },
    });
    const { queryClient } = renderApp(
      server,
      "/specs/1/review?view=all&file=src/a.ts",
    );
    expect(await screen.findByText("+b")).toBeTruthy();
    head = NEW_HEAD;
    await queryClient.invalidateQueries({ queryKey: ["spec", 1, "review"] });
    expect(
      await screen.findByText(
        new RegExp(`PR 有新提交：切换到 ${NEW_HEAD.slice(0, 7)}`),
      ),
    ).toBeTruthy();
    expect(screen.getByText("+b")).toBeTruthy();
    expect(screen.queryByText("src/brand-new.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    expect(
      (await screen.findAllByText("src/brand-new.ts")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("+b")).toBeNull();
  });

  it("says the diff is incomplete and still lists omitted files with a host link", async () => {
    renderApp(
      reviewServer({
        review: {
          revision: { complete: false, filesCount: 1, viewedCount: 1 },
        },
        revision: {
          complete: false,
          filesCount: 1,
          files: [
            aFile({
              path: "assets/logo.png",
              binary: true,
              patchOmitted: "binary",
              hunks: null,
            }),
          ],
        },
        routes: {
          "GET /review-files/11": () => ({
            json: {
              id: 11,
              path: "assets/logo.png",
              view: "all",
              patch: null,
              patchOmitted: "binary",
            },
          }),
        },
      }),
      "/specs/1/review?view=all",
    );
    expect(await screen.findByText("这份 diff 不完整")).toBeTruthy();
    expect(screen.getByText("已看 1/1")).toBeTruthy();
    expect(screen.queryByText("全部看完")).toBeNull();
    expect((await screen.findAllByText(/二进制/)).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "到托管上看" }).getAttribute("href"),
    ).toBe("https://github.com/me/shop/pull/12");
  });

  it("says the platform summary comment was not written", async () => {
    renderApp(
      reviewServer({
        review: { reviewNoteError: "GitHub answered 403" },
      }),
      "/specs/1/review",
    );
    expect(
      await screen.findByText("PR 上的汇总评论没写上：GitHub answered 403"),
    ).toBeTruthy();
  });

  it("fills the right rail from the pack, the current file's tickets, and Findings", async () => {
    renderApp(reviewServer(), "/specs/1/review?view=all&file=src/a.ts");
    await screen.findAllByText("src/a.ts");
    fireEvent.click(screen.getByRole("tab", { name: "合并前清单" }));
    expect(screen.getByText(/which format/)).toBeTruthy();
    expect(screen.getByText(/export works/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "需求与票" }));
    expect(
      screen.getByText(/As a merchant, I want to export orders/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "T-1" }).getAttribute("href")).toBe(
      "/tickets/1",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Finding" }));
    expect(screen.getByText(/handle empty export/)).toBeTruthy();
    expect(screen.getByText(/已交给 fix 处理/)).toBeTruthy();
  });

  it("does not fire review keys while the filter box is focused", async () => {
    const { router } = renderApp(
      reviewServer(),
      "/specs/1/review?view=all&file=src/a.ts",
    );
    await screen.findAllByText("src/a.ts");
    const box = screen.getByRole("textbox", { name: "过滤路径" });
    box.focus();
    fireEvent.keyDown(box, { key: "j" });
    expect(searchOf(router)).not.toMatch(/a\.test\.ts/);
  });

  it("posts a line draft from a line number and lists it as C-n", async () => {
    const server = reviewServer();
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    await screen.findByText("+b");
    fireEvent.click(
      screen.getByRole("button", { name: "写意见 src/a.ts 新侧第 1 行" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "人审意见" }), {
      target: { value: "empty list should return 200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("C-1")).toBeTruthy();
    expect(screen.getByText("empty list should return 200")).toBeTruthy();
    expect(
      server.calls.some((call) =>
        call.startsWith("POST /pull-requests/7/review-comments"),
      ),
    ).toBe(true);
  });

  it("posts a file draft and a PR draft", async () => {
    const server = reviewServer();
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    await screen.findByText("+b");
    fireEvent.click(
      screen.getByRole("button", { name: "写文件意见 src/a.ts" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "人审意见" }), {
      target: { value: "rename this function" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("C-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "写 PR 意见" }));
    fireEvent.change(screen.getByRole("textbox", { name: "人审意见" }), {
      target: { value: "migrations must be safe to re-run" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("C-2")).toBeTruthy();
    expect(
      server.calls.filter((call) =>
        call.startsWith("POST /pull-requests/7/review-comments"),
      ),
    ).toHaveLength(2);
  });

  it("opens compose on the current line from c, then edits and deletes the draft", async () => {
    const server = reviewServer();
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    await screen.findByText("+b");
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.change(screen.getByRole("textbox", { name: "人审意见" }), {
      target: { value: "first wording" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("C-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑 C-1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "人审意见" }), {
      target: { value: "second wording" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByText("second wording")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除 C-1" }));
    await waitFor(() => expect(screen.queryByText("C-1")).toBeNull());
    expect(
      server.calls.some((call) => call === "PATCH /review-comments/1"),
    ).toBe(true);
    expect(
      server.calls.some((call) => call === "DELETE /review-comments/1"),
    ).toBe(true);
  });

  it("shows the draft count on 提交修改要求 and does not submit a Change request", async () => {
    const server = reviewServer({
      comments: [aComment(), aComment({ id: 2, displayId: "C-2" })],
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    expect(
      await screen.findByRole("button", { name: "提交修改要求（2）" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交修改要求（2）" }));
    await waitFor(() =>
      expect(
        server.calls.some((call) => call === "POST /specs/1/change-requests"),
      ).toBe(true),
    );
  });

  it("asks to confirm stale drafts before submitting a Change request", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const server = reviewServer({
      comments: [aComment({ writtenOn: SHA2 })],
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    fireEvent.click(
      await screen.findByRole("button", { name: "提交修改要求（1）" }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]?.[0]).toBe(
      staleChangeRequestPrompt([
        { displayId: "C-1", writtenOn: SHA2, currentHead: SHA },
      ]),
    );
    await waitFor(() =>
      expect(
        server.calls.filter((call) => call === "POST /specs/1/change-requests"),
      ).toHaveLength(2),
    );
  });

  it("shows the partially-merged sentence next to 提交修改要求", async () => {
    renderApp(
      reviewServer({
        review: { spec: { state: "partially-merged", displayId: "S-1" } },
        comments: [aComment()],
      }),
      "/specs/1/review?view=all&file=src/a.ts",
    );
    expect(
      await screen.findByRole("button", { name: "提交修改要求（1）" }),
    ).toBeTruthy();
    expect(
      screen.getByText(changeRequestPartiallyMergedMessage("S-1")),
    ).toBeTruthy();
  });

  it("shows why a Change request was refused", async () => {
    const server = reviewServer({
      comments: [aComment()],
      routes: {
        "POST /specs/1/change-requests": () => ({
          status: 409,
          json: { error: CHANGE_REQUEST_IN_REWORK },
        }),
      },
    });
    renderApp(server, "/specs/1/review?view=all&file=src/a.ts");
    fireEvent.click(
      await screen.findByRole("button", { name: "提交修改要求（1）" }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      CHANGE_REQUEST_IN_REWORK,
    );
  });

  it("marks a comment written on an older revision and is read-only off awaiting-review", async () => {
    const oldSha = SHA2;
    renderApp(
      reviewServer({
        review: { spec: { state: "finalizing" } },
        comments: [
          aComment({
            writtenOn: oldSha,
            state: "submitted",
            body: "from last look",
          }),
        ],
      }),
      "/specs/1/review?view=all&file=src/a.ts",
    );
    expect(await screen.findByText("C-1")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`写于 ${oldSha.slice(0, 7)}`)),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "写 PR 意见" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "人审意见" })).toBeNull();
  });
});
