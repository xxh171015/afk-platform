import { describe, expect, it } from "vitest";
import { createSeed } from "@/api/mock/seed";
import { buildWorkbench, DEFAULT_STAGE_MEAN_MS, specStateText, ticketStateText } from "@/lib/view-map";
import { specStateLabel, ticketStateLabel } from "@/lib/labels";

const now = Date.parse("2026-11-01T11:10:00Z");

describe("workbench demo and mapping rules", () => {
  it("uses the requested stage means", () => {
    expect(DEFAULT_STAGE_MEAN_MS.implement).toBe(240_000);
    expect(DEFAULT_STAGE_MEAN_MS.gate).toBe(90_000);
    expect(DEFAULT_STAGE_MEAN_MS.review).toBe(60_000);
    expect(DEFAULT_STAGE_MEAN_MS.merge).toBe(20_000);
  });

  it("seeds S-11 as merged with only done tickets", () => {
    const db = createSeed(now);
    const spec = db.specs.find(s => s.displayId === "S-11");
    expect(spec?.state).toBe("merged");
    expect(spec?.title).toBe("历史订单查询");
    const tickets = db.tickets.filter(t => t.specId === spec?.id);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every(t => t.state === "done")).toBe(true);
  });

  it("seeds a 12 minute slow T-104 and a 30 second normal T-107", () => {
    const db = createSeed(now);
    const view = buildWorkbench({ ...db, blocked: { tickets: [], finalizations: [], pullRequests: [], cleanups: [], readyFailures: [], specs: [] }, now, stageMeans: DEFAULT_STAGE_MEAN_MS });
    expect(view.running.map(t => [t.ticketDisplayId, t.elapsedMs, t.slow])).toEqual([
      ["T-104", 720_000, true], ["T-107", 30_000, false],
    ]);
    expect(view.recentlyMerged.map(s => s.displayId)).toEqual(["S-11"]);
  });

  it("retains all six blocked categories in API order with the correct destinations", () => {
    const db = createSeed(now);
    const blocked = {
      tickets: db.tickets.filter(t => t.state === "blocked"),
      finalizations: db.finalizations.filter(f => f.state === "blocked"),
      pullRequests: db.pullRequests.filter(p => p.state === "closed" || p.syncError),
      cleanups: db.cleanups, readyFailures: db.readyFailures,
      specs: db.specs.filter(s => s.state === "paused"),
    };
    const view = buildWorkbench({ ...db, blocked, now, stageMeans: {} });
    expect(view.waiting.map(w => w.kind)).toEqual(["ticket", "ticket", "finalization", "finalization", "pr", "pr", "cleanup", "readyFailure", "spec"]);
    expect(view.waiting.map(w => w.href)).toEqual([
      "/tickets/tkt_103", "/tickets/tkt_105", "/specs/spec_13", "/specs/spec_18",
      "https://github.com/shop/afk-pilot-backend/pull/482", "https://github.com/shop/afk-pilot-backend/pull/476",
      "/specs/spec_13", "/specs/spec_14", "/specs/spec_16",
    ]);
    expect(view.waitingCount).toBe(9);
  });

  it("keeps status labels consistent for every existing enum", () => {
    for (const state of Object.keys(specStateLabel) as (keyof typeof specStateLabel)[]) {
      expect(specStateText(state)).toEqual({ label: specStateLabel[state], code: state });
    }
    for (const state of Object.keys(ticketStateLabel) as (keyof typeof ticketStateLabel)[]) {
      expect(ticketStateText(state)).toEqual({ label: ticketStateLabel[state], code: state });
    }
  });
});