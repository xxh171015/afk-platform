// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewQueue } from "./ReviewQueue.tsx";
import {
  emptyWorkbench,
  fakeServer,
  renderApp,
  renderWithApp,
} from "./test-utils.tsx";

afterEach(cleanup);

const emptyQueue = {
  waitingForYou: [] as unknown[],
  inProgress: [] as unknown[],
  inRework: [] as unknown[],
  readyToMerge: [] as unknown[],
};

function row(over: Record<string, unknown> = {}) {
  return {
    spec: {
      id: 5,
      displayId: "S-5",
      title: "Export",
      type: "feature",
      state: "awaiting-review",
      project: "shop",
    },
    repos: ["backend"],
    hostKind: "github",
    pullRequestCount: 1,
    waitingSince: "2026-11-26T12:00:00.000Z",
    additions: 12,
    deletions: 3,
    viewedCount: 0,
    filesCount: 4,
    ci: "none",
    conflictsWithDefault: false,
    autoMergeLine: null,
    riskTags: [] as string[],
    ...over,
  };
}

describe("the review queue page", () => {
  it("groups rows and links each spec to its review page", async () => {
    renderWithApp(
      <ReviewQueue />,
      fakeServer({
        "GET /review-queue": () => ({
          json: {
            waitingForYou: [
              row({
                riskTags: ["待人定"],
              }),
            ],
            inProgress: [
              row({
                spec: {
                  id: 6,
                  displayId: "S-6",
                  title: "Half",
                  type: "bug",
                  state: "awaiting-review",
                  project: "shop",
                },
                viewedCount: 1,
                filesCount: 4,
              }),
            ],
            inRework: [
              row({
                spec: {
                  id: 7,
                  displayId: "S-7",
                  title: "Reworking",
                  type: "feature",
                  state: "reworking",
                  project: "shop",
                },
              }),
            ],
            readyToMerge: [
              row({
                spec: {
                  id: 8,
                  displayId: "S-8",
                  title: "Ready",
                  type: "feature",
                  state: "partially-merged",
                  project: "shop",
                },
                viewedCount: 4,
                filesCount: 4,
              }),
            ],
          },
        }),
      }),
    );
    const waiting = within(await screen.findByTestId("review-group-等你审"));
    expect(waiting.getByText("Export").closest("a")?.getAttribute("href")).toBe(
      "/specs/5/review",
    );
    expect(waiting.getByText("待人定")).toBeTruthy();
    expect(waiting.getByText(/1 个 PR/)).toBeTruthy();
    expect(waiting.getByText("功能")).toBeTruthy();
    expect(waiting.getByText(/\+12 \/ −3/)).toBeTruthy();
    expect(waiting.getByText(/已看 0\/4/)).toBeTruthy();
    expect(
      within(screen.getByTestId("review-group-审到一半")).getByText("Half"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("review-group-返工中"))
        .getByText("Reworking")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/specs/7/review");
    expect(
      within(screen.getByTestId("review-group-看完待合并")).getByText("Ready"),
    ).toBeTruthy();
  });

  it("says MR for a GitLab spec", async () => {
    renderWithApp(
      <ReviewQueue />,
      fakeServer({
        "GET /review-queue": () => ({
          json: {
            ...emptyQueue,
            waitingForYou: [row({ hostKind: "gitlab", pullRequestCount: 2 })],
          },
        }),
      }),
    );
    expect(await screen.findByText(/2 个 MR/)).toBeTruthy();
  });

  it("shows 未计算 when a revision is not ready", async () => {
    renderWithApp(
      <ReviewQueue />,
      fakeServer({
        "GET /review-queue": () => ({
          json: {
            ...emptyQueue,
            waitingForYou: [
              row({
                viewedCount: null,
                filesCount: null,
                additions: 0,
                deletions: 0,
              }),
            ],
          },
        }),
      }),
    );
    expect(await screen.findByText(/未计算/)).toBeTruthy();
  });
});

describe("review queue entry points", () => {
  it("puts 待审 before 待处理 and badges 等你审 plus 审到一半", async () => {
    const fake = fakeServer({
      "GET /workbench": () => ({ json: emptyWorkbench }),
      "GET /blocked": () => ({ json: emptyWorkbench.waiting }),
      "GET /review-queue": () => ({
        json: {
          waitingForYou: [row()],
          inProgress: [
            row({
              spec: {
                id: 6,
                displayId: "S-6",
                title: "Half",
                type: "feature",
                state: "awaiting-review",
                project: "shop",
              },
            }),
          ],
          inRework: [
            row({
              spec: {
                id: 7,
                displayId: "S-7",
                title: "Rework",
                type: "feature",
                state: "reworking",
                project: "shop",
              },
            }),
          ],
          readyToMerge: [
            row({
              spec: {
                id: 8,
                displayId: "S-8",
                title: "Ready",
                type: "feature",
                state: "awaiting-review",
                project: "shop",
              },
            }),
          ],
        },
      }),
      "GET /projects": () => ({ json: { projects: [] } }),
    });
    renderApp(fake, "/");
    const review = await screen.findAllByRole("link", { name: "待审 (2)" });
    const waiting = screen.getAllByRole("link", { name: "待处理" });
    expect(review[0]?.getAttribute("href")).toBe("/review");
    expect(waiting[0]?.getAttribute("href")).toBe("/waiting");
    expect(
      review[0] &&
        waiting[0] &&
        !!(
          review[0].compareDocumentPosition(waiting[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ).toBe(true);
  });
});
