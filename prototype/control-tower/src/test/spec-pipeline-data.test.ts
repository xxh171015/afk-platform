import { beforeEach, describe, expect, it } from "vitest";
import { createSeed } from "@/api/mock/seed";
import { getSpec, resetMockDb } from "@/api/mock/server";
import { CLOSED_TIMELINE_TYPES, specPipeline } from "@/lib/view-map";

beforeEach(() => resetMockDb({ liveTicks: false }));
describe("spec pipeline DTO rules", () => {
  it("defaults paused without anomalyFrom to running", () => {
    expect(specPipeline({ state: "paused", pullRequests: [] })).toEqual({ currentStep: "运行", currentIndex: 2, allComplete: false, banner: { kind: "paused", label: "暂停" } });
  });
  it("treats any existing PR as the opening step while finalizing", () => {
    expect(specPipeline({ state: "finalizing", pullRequests: [{ state: "closed" }] }).currentIndex).toBe(4);
  });
  it("seeds the requested remaining times and paused origin", () => {
    expect(getSpec("spec_12").spec.etaMinutes).toBe(40);
    expect(getSpec("spec_13").spec.etaMinutes).toBe(15);
    expect(getSpec("spec_11").spec.etaMinutes).toBeNull();
    expect(getSpec("spec_16").spec.anomalyFrom).toBe("running");
  });
  it("returns multiple closed events for both running and finalizing examples", () => {
    for (const id of ["spec_12", "spec_13"]) {
      const { timeline } = getSpec(id);
      expect(timeline.length).toBeGreaterThan(5);
      expect(timeline.every(e => CLOSED_TIMELINE_TYPES.some(t => t === e.type))).toBe(true);
      expect(timeline.some(e => e.type === "confirmed")).toBe(true);
    }
    expect(getSpec("spec_12").timeline.some(e => e.type === "ticket-blocked")).toBe(true);
    expect(getSpec("spec_13").timeline.some(e => e.type === "finalizing-entered")).toBe(true);
  });
  it("preserves finalization run identities in both stopped deliveries", () => {
    const db = createSeed();
    for (const id of ["spec_13", "spec_18"]) {
      for (const f of db.finalizations.filter(f => f.specId === id && f.runId)) {
        expect(db.runs.find(r => r.id === f.runId)?.displayId).toBe(f.runDisplayId);
      }
    }
  });
});