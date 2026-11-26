import { describe, expect, it } from "vitest";
import {
  CHANGE_REQUEST_IN_REWORK,
  CHANGE_REQUEST_NOT_AWAITING,
  changeRequestBlockedMessage,
  changeRequestPartiallyMergedMessage,
  staleChangeRequestPrompt,
} from "./change-requests.ts";

describe("changeRequestBlockedMessage", () => {
  it("names a bug spec when the spec is already partially merged", () => {
    expect(changeRequestBlockedMessage("partially-merged", "S-70")).toBe(
      changeRequestPartiallyMergedMessage("S-70"),
    );
    expect(changeRequestPartiallyMergedMessage("S-70")).toBe(
      "已有 PR 合并，不能再提交修改要求。还要改的部分，请在规划机器上建一个指向 S-70 的 bug 需求。",
    );
  });

  it("says wait when the spec is already in rework", () => {
    expect(changeRequestBlockedMessage("finalizing", "S-1")).toBe(
      CHANGE_REQUEST_IN_REWORK,
    );
    expect(changeRequestBlockedMessage("reworking", "S-1")).toBe(
      CHANGE_REQUEST_IN_REWORK,
    );
  });

  it("says the spec is not waiting for review in any other state", () => {
    expect(changeRequestBlockedMessage("running", "S-1")).toBe(
      CHANGE_REQUEST_NOT_AWAITING,
    );
    expect(changeRequestBlockedMessage("awaiting-review", "S-1")).toBeNull();
  });
});

describe("staleChangeRequestPrompt", () => {
  it("asks to confirm drafts written on an older head", () => {
    expect(
      staleChangeRequestPrompt([
        {
          displayId: "C-1",
          writtenOn: "a".repeat(40),
          currentHead: "e".repeat(40),
        },
        {
          displayId: "C-2",
          writtenOn: "a".repeat(40),
          currentHead: "e".repeat(40),
        },
        {
          displayId: "C-3",
          writtenOn: "a".repeat(40),
          currentHead: "e".repeat(40),
        },
      ]),
    ).toBe(
      "3 条意见写在 `aaaaaaa` 上，PR 现在是 `eeeeeee`；agent 会看到意见写下时的那几行代码。仍然提交？",
    );
  });
});
