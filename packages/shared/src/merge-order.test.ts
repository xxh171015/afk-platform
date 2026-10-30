import { describe, expect, it } from "vitest";
import { mergeOrder } from "./merge-order.ts";

describe("mergeOrder", () => {
  it("puts the repo whose contract is used first, and says what each later repo waits for", () => {
    expect(
      mergeOrder(
        ["backend", "frontend"],
        [{ from: "backend", to: "frontend" }],
      ),
    ).toEqual({
      ordered: ["backend", "frontend"],
      after: { backend: [], frontend: ["backend"] },
      unordered: [],
    });
  });

  it("leaves repos without a contract relation out of the order", () => {
    expect(
      mergeOrder(
        ["backend", "docs", "frontend"],
        [{ from: "backend", to: "frontend" }],
      ),
    ).toMatchObject({ ordered: ["backend", "frontend"], unordered: ["docs"] });
  });

  it("orders three repos along two relations, whatever the order they are listed in", () => {
    const result = mergeOrder(
      ["frontend", "payments", "backend"],
      [
        { from: "backend", to: "frontend" },
        { from: "payments", to: "backend" },
      ],
    );
    expect(result.ordered).toEqual(["payments", "backend", "frontend"]);
    expect(result.after).toEqual({
      payments: [],
      backend: ["payments"],
      frontend: ["backend"],
    });
  });

  it("counts a repo that uses two contracts as waiting for both, and ignores repeated and same-repo relations", () => {
    const result = mergeOrder(
      ["a", "b", "c"],
      [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
        { from: "b", to: "b" },
      ],
    );
    expect(result.after.c).toEqual(["a", "b"]);
    expect(result.ordered).toEqual(["a", "b", "c"]);
    expect(result.unordered).toEqual([]);
  });
});
