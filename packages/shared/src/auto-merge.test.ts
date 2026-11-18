import { describe, expect, it } from "vitest";
import {
  type AutoMergeInput,
  type AutoMergePull,
  autoMergeForecast,
} from "./auto-merge.ts";

const ENTERED = new Date("2026-01-01T00:00:00Z");
const DUE_AT = new Date("2026-01-01T00:30:00Z");

const readyPull = (extra: Partial<AutoMergePull> = {}): AutoMergePull => ({
  state: "open",
  draft: false,
  ci: "success",
  review: "none",
  conflictsWithDefault: false,
  humanComments: 0,
  headSha: "abc123",
  ...extra,
});

const ready = (extra: Partial<AutoMergeInput> = {}): AutoMergeInput => ({
  mergePolicy: "auto-improvement",
  specType: "improvement",
  specState: "awaiting-review",
  pullRequests: [readyPull()],
  needsDecision: [],
  awaitingReviewAt: ENTERED,
  hadAutoMergeJob: false,
  now: DUE_AT,
  ...extra,
});

describe("autoMergeForecast", () => {
  it("will merge when every condition is met and 30 minutes have passed", () => {
    expect(autoMergeForecast(ready())).toEqual({
      willMerge: true,
      mergeAt: DUE_AT,
      due: true,
    });
  });

  it("will not merge when the project policy is not auto-improvement", () => {
    expect(autoMergeForecast(ready({ mergePolicy: "manual" }))).toEqual({
      willMerge: false,
      reason: "项目合并策略不是 auto-improvement",
    });
  });

  it("will not merge when the spec type is not improvement", () => {
    expect(autoMergeForecast(ready({ specType: "feature" }))).toEqual({
      willMerge: false,
      reason: "需求类型不是 improvement",
    });
  });

  it("will not merge when the spec is not awaiting-review", () => {
    expect(autoMergeForecast(ready({ specState: "running" }))).toEqual({
      willMerge: false,
      reason: "需求不在 awaiting-review",
    });
  });

  it("will not merge when the spec does not have exactly one pull request", () => {
    expect(
      autoMergeForecast(ready({ pullRequests: [readyPull(), readyPull()] })),
    ).toEqual({
      willMerge: false,
      reason: "需求不是只有一个 PR",
    });
  });

  it("will not merge when the pull request is a draft", () => {
    expect(
      autoMergeForecast(ready({ pullRequests: [readyPull({ draft: true })] })),
    ).toEqual({
      willMerge: false,
      reason: "PR 不是打开的非草稿",
    });
  });

  it("will not merge when CI is pending or failure", () => {
    expect(
      autoMergeForecast(
        ready({ pullRequests: [readyPull({ ci: "pending" })] }),
      ),
    ).toEqual({
      willMerge: false,
      reason: "CI 是 pending 或 failure",
    });
  });

  it("will not merge when the pull request conflicts with the default branch", () => {
    expect(
      autoMergeForecast(
        ready({ pullRequests: [readyPull({ conflictsWithDefault: true })] }),
      ),
    ).toEqual({
      willMerge: false,
      reason: "PR 与默认分支冲突",
    });
  });

  it("will not merge when review is changes-requested", () => {
    expect(
      autoMergeForecast(
        ready({
          pullRequests: [readyPull({ review: "changes-requested" })],
        }),
      ),
    ).toEqual({
      willMerge: false,
      reason: "PR 被要求修改",
    });
  });

  it("will not merge when a person has commented on the pull request", () => {
    expect(
      autoMergeForecast(
        ready({ pullRequests: [readyPull({ humanComments: 1 })] }),
      ),
    ).toEqual({
      willMerge: false,
      reason: "PR 上有人写过评论",
    });
  });

  it("will not merge while the comment count is unknown", () => {
    expect(
      autoMergeForecast(
        ready({ pullRequests: [readyPull({ humanComments: null })] }),
      ),
    ).toEqual({
      willMerge: false,
      reason: "还不知道 PR 上有没有人评论",
    });
  });

  it("will not merge when the time it entered awaiting-review is unknown", () => {
    expect(autoMergeForecast(ready({ awaitingReviewAt: null }))).toEqual({
      willMerge: false,
      reason: "找不到需求进入 awaiting-review 的时间",
    });
  });

  it("will not merge when the acceptance pack has a needs-human item", () => {
    expect(
      autoMergeForecast(ready({ needsDecision: [{ kind: "needs-human" }] })),
    ).toEqual({
      willMerge: false,
      reason: "验收包有 needs-human",
    });
  });

  it("will not merge when the acceptance pack has an unfinished deferred item", () => {
    expect(
      autoMergeForecast(ready({ needsDecision: [{ kind: "deferred" }] })),
    ).toEqual({
      willMerge: false,
      reason: "验收包有未做掉的 deferred",
    });
  });

  it("will not merge when the acceptance pack has a host-check item", () => {
    expect(
      autoMergeForecast(ready({ needsDecision: [{ kind: "host-check" }] })),
    ).toEqual({
      willMerge: false,
      reason: "需要在宿主机上验证",
    });
  });

  it("will not merge when the spec already had an auto-merge job", () => {
    expect(autoMergeForecast(ready({ hadAutoMergeJob: true }))).toEqual({
      willMerge: false,
      reason: "已经有过 auto-merge 作业",
    });
  });

  it("will merge but is not due before 30 minutes have passed", () => {
    const now = new Date(DUE_AT.getTime() - 1);
    expect(autoMergeForecast(ready({ now }))).toEqual({
      willMerge: true,
      mergeAt: DUE_AT,
      due: false,
    });
  });

  it("will merge and is due after 30 minutes have passed", () => {
    const now = new Date(DUE_AT.getTime() + 1);
    expect(autoMergeForecast(ready({ now }))).toEqual({
      willMerge: true,
      mergeAt: DUE_AT,
      due: true,
    });
  });
});
