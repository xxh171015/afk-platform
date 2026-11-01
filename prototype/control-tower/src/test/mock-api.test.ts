import { beforeEach, describe, expect, it } from "vitest";

import * as m from "@/api/mock/server";

beforeEach(() => m.resetMockDb({ liveTicks: false }));

describe("mock API rules", () => {
  it("confirm is draft-only and starts scheduling imported tickets", () => {
    expect(() => m.confirmSpec("spec_12")).toThrow();
    m.confirmSpec("spec_17");
    const detail = m.getSpec("spec_17");
    expect(detail.spec.state).toBe("running");
    expect(detail.tickets.find((t) => t.displayId === "T-150")?.state).toBe("queued");
    expect(detail.tickets.find((t) => t.displayId === "T-151")?.state).toBe("pending");
  });
  it("resume rejects extraSeconds outside 1…604800 or non-integer", () => {
    expect(() => m.resumeSpec("spec_16", 0)).toThrow();
    expect(() => m.resumeSpec("spec_16", 604801)).toThrow();
    expect(() => m.resumeSpec("spec_16", 1.5)).toThrow();
    m.resumeSpec("spec_16", 604800);
    expect(m.getSpec("spec_16").spec.state).toBe("running");
  });

  it("merge order puts the contract-providing repo first", () => {
    const { mergeOrder } = m.getSpec("spec_12");
    expect(mergeOrder.ordered).toEqual(["afk-pilot-backend", "afk-pilot-frontend"]);
    expect(mergeOrder.after["afk-pilot-frontend"]).toEqual(["afk-pilot-backend"]);
  });

  it("merging frontend before backend is flagged as order broken", () => {
    expect(m.getSpec("spec_15").orderBroken).toEqual([{ repo: "afk-pilot-frontend", skipped: ["afk-pilot-backend"] }]);
  });

  it("waiting badge count equals the sum of all /blocked lists", () => {
    const b = m.getBlocked();
    const sum = b.tickets.length + b.finalizations.length + b.pullRequests.length + b.cleanups.length + b.readyFailures.length + b.specs.length;
    expect(m.blockedCount(b)).toBe(sum);
  });

  it("approve-protected only works for protected-path-changed", () => {
    expect(() => m.approveProtected("tkt_103")).toThrow();
    m.approveProtected("tkt_105");
    expect(m.getTicket("tkt_105").ticket.state).toBe("merging");
  });

  it("cancel without cascade blocks downstream with upstream-cancelled", () => {
    m.cancelTicket("tkt_104", false);
    const t108 = m.getTicket("tkt_108").ticket;
    expect(t108.state).toBe("blocked");
    expect(t108.blockedReason).toBe("upstream-cancelled");
  });

  it("cancel with cascade cancels downstream", () => {
    m.cancelTicket("tkt_104", true);
    expect(m.getTicket("tkt_108").ticket.state).toBe("cancelled");
    expect(m.getTicket("tkt_106").ticket.state).toBe("cancelled");
  });
});
