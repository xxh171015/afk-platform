import { beforeEach, describe, expect, it } from "vitest";
import { getSpec, resetMockDb, approveProtected, getTicket } from "@/api/mock/server";
import { acceptanceStats, exportAcceptanceMarkdown, prWaitsFor } from "@/lib/acceptance-report";

beforeEach(() => resetMockDb({ liveTicks: false }));
describe("merge and acceptance rules", () => {
  it("waits only for contract upstream repos that have not merged", () => {
    const detail = getSpec("spec_14");
    const pr = detail.pullRequests.find(p => p.repo === "afk-pilot-frontend");
    if (!pr) throw new Error("missing frontend PR");
    expect(prWaitsFor(pr, detail)).toEqual(["afk-pilot-backend"]);
    expect(prWaitsFor({ ...pr, state: "merged" }, detail)).toEqual([]);
  });
  it("counts verified criteria against all criteria and only unhandled findings", () => {
    const pack = getSpec("spec_14").acceptancePack;
    if (!pack) throw new Error("missing acceptance pack");
    expect(acceptanceStats(pack)).toEqual({ verified: 2, total: 3, unhandled: 1 });
  });
  it("retains approved paths after the pending approval is cleared", () => {
    const before = getTicket("tkt_105").ticket.protectedPaths;
    expect(before.length).toBeGreaterThan(0);
    approveProtected("tkt_105");
    expect(getTicket("tkt_105").ticket.protectedPaths).toEqual([]);
    expect(getTicket("tkt_105").ticket.approvedProtectedPaths).toEqual(before);
  });
  it("exports all report data including hidden fixed findings and cancelled tickets", () => {
    const detail = getSpec("spec_14");
    const markdown = exportAcceptanceMarkdown(detail);
    expect(markdown).toContain("coupon_stacking_test.go::TestMaxOnePerSource");
    expect(markdown).toContain("the agent named no test");
    expect(markdown).toContain("重复平台券未及时拒绝");
    expect(markdown).toContain("tests/coupons/legacy_cases.json");
    expect(markdown).toContain("~~T-124 旧版优惠券组合提示~~");
    expect(markdown.indexOf("## 已取消的票")).toBeGreaterThan(markdown.indexOf("## afk-pilot-frontend"));
  });
  it("exports nonzero gate exits and order-broken warnings without altering PR state", () => {
    const detail = getSpec("spec_15");
    expect(exportAcceptanceMarkdown(detail)).toContain("| test | 1m 05s | 1 |");
    expect(detail.orderBroken[0]?.skipped).toEqual(["afk-pilot-backend"]);
    expect(getSpec("spec_15").pullRequests.find(p => p.repo === "afk-pilot-backend")?.state).toBe("closed");
  });
});