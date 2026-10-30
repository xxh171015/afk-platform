import { describe, expect, it } from "vitest";
import { isRunnable } from "./runnable.ts";

const roomToSpare = [
  { scope: "global", resource: "concurrency", used: 0, max: 4 },
] as const;

describe("isRunnable: ticket state and same-spec edges", () => {
  it("a pending ticket with no incoming edges and room to spare can start", () => {
    expect(
      isRunnable({ state: "pending", edges: [], limits: roomToSpare }),
    ).toEqual({
      runnable: true,
    });
  });

  it.each([
    "queued",
    "running",
    "merging",
    "done",
    "blocked",
    "cancelled",
  ] as const)("a %s ticket cannot be started again", (state) => {
    const result = isRunnable({ state, edges: [], limits: roomToSpare });
    expect(result.runnable).toBe(false);
  });

  it("a blocks edge is satisfied once the blocker is done", () => {
    const edges = [
      { kind: "blocks", scope: "same-spec", blockerState: "done" },
    ] as const;
    expect(
      isRunnable({ state: "pending", edges, limits: roomToSpare }).runnable,
    ).toBe(true);
  });

  it.each([
    "pending",
    "queued",
    "running",
    "merging",
    "blocked",
    "cancelled",
  ] as const)(
    "a blocks edge is not satisfied while the blocker is %s",
    (blockerState) => {
      const edges = [
        { kind: "blocks", scope: "same-spec", blockerState },
      ] as const;
      expect(
        isRunnable({ state: "pending", edges, limits: roomToSpare }).runnable,
      ).toBe(false);
    },
  );

  it("a contract edge also needs the contract SHA to have been recorded", () => {
    const withSha = [
      {
        kind: "contract",
        scope: "same-spec",
        blockerState: "done",
        contractSha: "abc123",
      },
    ] as const;
    const withoutSha = [
      { kind: "contract", scope: "same-spec", blockerState: "done" },
    ] as const;
    expect(
      isRunnable({ state: "pending", edges: withSha, limits: roomToSpare })
        .runnable,
    ).toBe(true);
    expect(
      isRunnable({ state: "pending", edges: withoutSha, limits: roomToSpare })
        .runnable,
    ).toBe(false);
  });

  it("every incoming edge must be satisfied, not just one", () => {
    const edges = [
      { kind: "blocks", scope: "same-spec", blockerState: "done" },
      { kind: "blocks", scope: "same-spec", blockerState: "running" },
    ] as const;
    expect(
      isRunnable({ state: "pending", edges, limits: roomToSpare }).runnable,
    ).toBe(false);
  });
});

describe("isRunnable: cross-spec edges", () => {
  it.each(["blocks", "contract"] as const)(
    "a cross-spec %s edge needs no contract SHA, only the caller's satisfied fact",
    (kind) => {
      const edges = [{ kind, scope: "cross-spec", satisfied: true }] as const;
      expect(
        isRunnable({ state: "pending", edges, limits: roomToSpare }).runnable,
      ).toBe(true);
    },
  );

  it("is satisfied only when the caller says the blocker's PR is in main and in our integration branch", () => {
    const ready = [
      { kind: "blocks", scope: "cross-spec", satisfied: true },
    ] as const;
    const notYet = [
      { kind: "blocks", scope: "cross-spec", satisfied: false },
    ] as const;
    expect(
      isRunnable({ state: "pending", edges: ready, limits: roomToSpare })
        .runnable,
    ).toBe(true);
    expect(
      isRunnable({ state: "pending", edges: notYet, limits: roomToSpare })
        .runnable,
    ).toBe(false);
  });
});

describe("isRunnable: concurrency and budget limits", () => {
  it.each(["global", "project", "repo"] as const)(
    "room left at %s scope is fine",
    (scope) => {
      const capacity = [
        { scope, resource: "concurrency", used: 2, max: 3 },
      ] as const;
      expect(
        isRunnable({ state: "pending", edges: [], limits: capacity }).runnable,
      ).toBe(true);
    },
  );

  it.each(["global", "project", "repo"] as const)(
    "a full %s concurrency limit blocks",
    (scope) => {
      const capacity = [
        { scope, resource: "concurrency", used: 3, max: 3 },
      ] as const;
      expect(
        isRunnable({ state: "pending", edges: [], limits: capacity }),
      ).toEqual({
        runnable: false,
        reasons: [{ type: "no-capacity", capacity: capacity[0] }],
      });
    },
  );

  it("an exhausted budget blocks even when concurrency has room", () => {
    const capacity = [
      { scope: "project", resource: "concurrency", used: 0, max: 3 },
      { scope: "project", resource: "budget", used: 100, max: 100 },
    ] as const;
    expect(
      isRunnable({ state: "pending", edges: [], limits: capacity }).runnable,
    ).toBe(false);
  });

  it("reports every reason, not just the first", () => {
    const capacity = [
      { scope: "repo", resource: "concurrency", used: 1, max: 1 },
    ] as const;
    const edges = [
      { kind: "blocks", scope: "same-spec", blockerState: "running" },
    ] as const;
    const result = isRunnable({ state: "pending", edges, limits: capacity });
    expect(
      result.runnable === false && result.reasons.map((r) => r.type),
    ).toEqual(["edge-unsatisfied", "no-capacity"]);
  });
});
