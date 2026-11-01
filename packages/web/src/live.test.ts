import { describe, expect, it } from "vitest";
import { queryKeysForInvalidate, resourcePollMs } from "./live.ts";

describe("resourcePollMs", () => {
  it("turns polling off while SSE is connected, and restores the old interval when it is not", () => {
    expect(resourcePollMs(true, 5_000)).toBe(false);
    expect(resourcePollMs(false, 5_000)).toBe(5_000);
    expect(resourcePollMs(false, 3_000)).toBe(3_000);
  });
});

describe("queryKeysForInvalidate", () => {
  it("invalidates only the workbench and waiting when no id is filled", () => {
    expect(queryKeysForInvalidate({})).toEqual([["workbench"], ["blocked"]]);
  });

  it("invalidates the matching resource plus workbench and waiting for each filled id", () => {
    expect(queryKeysForInvalidate({ specId: 3 })).toEqual([
      ["workbench"],
      ["blocked"],
      ["spec", 3],
      ["specs"],
    ]);
    expect(queryKeysForInvalidate({ ticketId: 9 })).toEqual([
      ["workbench"],
      ["blocked"],
      ["ticket", 9],
    ]);
    expect(queryKeysForInvalidate({ runId: 12 })).toEqual([
      ["workbench"],
      ["blocked"],
      ["log", 12],
      ["run", 12],
    ]);
    expect(
      queryKeysForInvalidate({ specId: 3, ticketId: 9, runId: 12 }),
    ).toEqual([
      ["workbench"],
      ["blocked"],
      ["spec", 3],
      ["specs"],
      ["ticket", 9],
      ["log", 12],
      ["run", 12],
    ]);
  });
});
