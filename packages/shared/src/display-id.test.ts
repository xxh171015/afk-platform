import { describe, expect, it } from "vitest";
import { formatDisplayId, parseDisplayId } from "./display-id.ts";

describe("formatDisplayId", () => {
  it.each([
    ["spec", 12, "S-12"],
    ["ticket", 123, "T-123"],
    ["run", 456, "R-456"],
    ["ticket", 1, "T-1"],
  ] as const)("%s %i is shown as %s", (kind, id, shown) => {
    expect(formatDisplayId(kind, id)).toBe(shown);
  });

  it.each([0, -3, 1.5, Number.NaN])("refuses the serial id %s", (id) => {
    expect(() => formatDisplayId("ticket", id)).toThrow();
  });
});

describe("parseDisplayId", () => {
  it.each([
    ["S-12", "spec", 12],
    ["T-123", "ticket", 123],
    ["R-456", "run", 456],
  ] as const)("%s is a %s with serial id %i", (shown, kind, id) => {
    expect(parseDisplayId(shown)).toEqual({ kind, id });
  });

  it.each([
    "",
    "X-1",
    "t-1",
    "T1",
    "T-",
    "T-0",
    "T-01",
    "T--1",
    "T-1.5",
    " T-1",
    "T-1 ",
    "T-1-2",
    "S-12abc",
  ])("does not read %j as a display id", (text) => {
    expect(parseDisplayId(text)).toBeUndefined();
  });

  it("reads back whatever formatDisplayId produced", () => {
    for (const kind of ["spec", "ticket", "run"] as const) {
      expect(parseDisplayId(formatDisplayId(kind, 9007))).toEqual({
        kind,
        id: 9007,
      });
    }
  });
});
