import { describe, expect, it } from "vitest";
import { leadTime, runLeadSegment } from "./lead-time.ts";

const hour = 3_600_000;
const t0 = Date.parse("2026-01-01T00:00:00Z");

describe("leadTime", () => {
  it("splits wall time so the four segments sum to the span", () => {
    const result = leadTime({
      confirmAt: t0,
      endAt: t0 + 10 * hour,
      agent: [{ startMs: t0 + hour, endMs: t0 + 4 * hour }],
      gate: [{ startMs: t0 + 4 * hour, endMs: t0 + 5 * hour }],
      queued: [{ startMs: t0, endMs: t0 + hour }],
    });
    expect(result).toEqual({
      agentMs: 3 * hour,
      gateMs: hour,
      queuedMs: hour,
      waitingMs: 5 * hour,
      totalMs: 10 * hour,
    });
    expect(
      (result?.agentMs ?? 0) +
        (result?.gateMs ?? 0) +
        (result?.queuedMs ?? 0) +
        (result?.waitingMs ?? 0),
    ).toBe(result?.totalMs);
  });

  it("counts overlapping agent runs of parallel tickets once", () => {
    const result = leadTime({
      confirmAt: t0,
      endAt: t0 + 4 * hour,
      agent: [
        { startMs: t0, endMs: t0 + 3 * hour },
        { startMs: t0 + hour, endMs: t0 + 4 * hour },
      ],
    });
    expect(result).toEqual({
      agentMs: 4 * hour,
      gateMs: 0,
      queuedMs: 0,
      waitingMs: 0,
      totalMs: 4 * hour,
    });
  });

  it("gives hours while another ticket is blocked to a running agent, not to 等人", () => {
    const result = leadTime({
      confirmAt: t0,
      endAt: t0 + 5 * hour,
      agent: [{ startMs: t0 + hour, endMs: t0 + 3 * hour }],
    });
    expect(result).toEqual({
      agentMs: 2 * hour,
      gateMs: 0,
      queuedMs: 0,
      waitingMs: 3 * hour,
      totalMs: 5 * hour,
    });
  });

  it("gives overlapping 排队 to a running agent, not to 排队", () => {
    const result = leadTime({
      confirmAt: t0,
      endAt: t0 + 5 * hour,
      agent: [{ startMs: t0 + hour, endMs: t0 + 3 * hour }],
      queued: [{ startMs: t0 + 2 * hour, endMs: t0 + 4 * hour }],
    });
    expect(result).toEqual({
      agentMs: 2 * hour,
      gateMs: 0,
      queuedMs: hour,
      waitingMs: 2 * hour,
      totalMs: 5 * hour,
    });
  });

  it("does not compute lead time for a cancelled spec", () => {
    expect(
      leadTime({
        confirmAt: t0,
        endAt: t0 + hour,
        cancelled: true,
        agent: [{ startMs: t0, endMs: t0 + hour }],
      }),
    ).toBeNull();
  });

  it("cuts an in-progress agent run at endAt", () => {
    const result = leadTime({
      confirmAt: t0,
      endAt: t0 + 2 * hour,
      agent: [{ startMs: t0 + hour, endMs: null }],
    });
    expect(result).toEqual({
      agentMs: hour,
      gateMs: 0,
      queuedMs: 0,
      waitingMs: hour,
      totalMs: 2 * hour,
    });
  });
});

describe("runLeadSegment", () => {
  it("counts implement, review and the update-branch merge agent as agent", () => {
    expect(runLeadSegment("implement", "done")).toBe("agent");
    expect(runLeadSegment("review", "pass")).toBe("agent");
    expect(runLeadSegment("update-branch", "done")).toBe("agent");
    expect(runLeadSegment("update-branch", "timeout")).toBe("agent");
    expect(runLeadSegment("update-branch", null, true)).toBe("agent");
  });

  it("counts gate, merge and a locked update-branch as 门禁", () => {
    expect(runLeadSegment("gate", "passed")).toBe("gate");
    expect(runLeadSegment("merge", "merged")).toBe("gate");
    expect(runLeadSegment("update-branch", "merged")).toBe("gate");
    expect(runLeadSegment("update-branch", "conflict")).toBe("gate");
    expect(runLeadSegment("update-branch", null, false)).toBe("gate");
  });
});
