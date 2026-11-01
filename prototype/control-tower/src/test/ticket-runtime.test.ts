import { beforeEach, describe, expect, it } from "vitest";
import { agentRunCount, appendLogChunk, emptyLogBuffer, findingGroup } from "@/lib/ticket-runtime";
import { getTicket, getRunLogs, resetMockDb } from "@/api/mock/server";
beforeEach(() => resetMockDb({ liveTicks: false }));
describe("ticket detail rules", () => {
  it("counts only implement review and each of three fixes as five agent stages", () => {
    const run = getTicket("tkt_103").runs[0];
    if (!run) throw new Error("missing run");
    const stages = ["implement", "review", "gate-fix", "review-fix", "merge-fix", "gate", "merge", "e2e", "diagnose"] as const;
    expect(agentRunCount(stages.map(stage => ({ ...run, stage })))).toBe(5);
  });
  it("restarts a buffer when attempt changes without appending the old offset", () => {
    const first = appendLogChunk(emptyLogBuffer(), { attempt: 1, offset: 0, nextOffset: 3, size: 6, text: "old", finished: false });
    const changed = appendLogChunk(first, { attempt: 2, offset: 3, nextOffset: 6, size: 6, text: "tail", finished: false });
    expect(changed.text).toBe(""); expect(changed.offset).toBe(0); expect(changed.restarted).toBe(true);
    const next = appendLogChunk(changed, { attempt: 2, offset: 0, nextOffset: 3, size: 3, text: "new", finished: true });
    expect(next.text).toBe("new"); expect(next.finished).toBe(true);
  });
  it("preserves explicit axes but never infers them for legacy findings", () => {
    const finding = getTicket("tkt_103").findings[0];
    if (!finding) throw new Error("missing finding");
    expect(findingGroup({ ...finding, axis: "Standards" })).toBe("Standards");
    expect(findingGroup({ ...finding, source: "gate" })).toBe("门禁");
    expect(findingGroup({ ...finding, source: "review" })).toBe("其他");
  });
  it("reads finished logs to completion by offset with masked credentials", () => {
    const run = getTicket("tkt_103").runs[0];
    if (!run) throw new Error("missing run");
    let buffer = emptyLogBuffer(); let calls = 0;
    while (!buffer.finished && calls++ < 20) buffer = appendLogChunk(buffer, getRunLogs(run.id, buffer.offset));
    expect(buffer.finished).toBe(true); expect(calls).toBeGreaterThan(1);
    expect(buffer.text).toContain('"API_KEY":"***"');
    expect(buffer.text).toContain('"type":"assistant"');
  });
  it("integration uses two repair rounds maximum", () => { expect(getTicket("tkt_106").integration?.maxLoops).toBe(2); });
});