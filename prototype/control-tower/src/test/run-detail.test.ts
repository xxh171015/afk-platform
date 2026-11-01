import { beforeEach, describe, expect, it } from "vitest";
import { getRun, getRunLogs, getTicket, resetMockDb } from "@/api/mock/server";
import { classifyLogLine } from "@/lib/view-map";
import { appendLogChunk, emptyLogBuffer } from "@/lib/ticket-runtime";

beforeEach(() => resetMockDb({ liveTicks: false }));
describe("Run detail mock", () => {
  it("includes a failed implement in T-103 history", () => {
    expect(getTicket("tkt_103").runs.some(r => r.stage === "implement" && r.state === "failed")).toBe(true);
  });
  it("exposes all four actions in offset-buffered Run logs", () => {
    let buffer = emptyLogBuffer();
    for (let i = 0; i < 20 && !buffer.finished; i++) buffer = appendLogChunk(buffer, getRunLogs("run_t103_impl_fail", buffer.offset));
    expect(buffer.finished).toBe(true);
    expect([...new Set(buffer.text.trim().split("\n").map(line => classifyLogLine(line).action))].sort()).toEqual(["读取", "修改", "运行命令", "agent 说明"].sort());
  });
  it("reads failed implement by id and displayId with WIP and failing tests", () => {
    const detail = getRun("run_t103_impl_fail");
    expect(detail.run.stage).toBe("implement");
    expect(detail.run.state).toBe("failed");
    expect(detail.ticket?.id).toBe("tkt_103");
    expect(detail.commits).toHaveLength(1);
    expect(detail.output).toMatchObject({ outcome: "failed", failingTests: ["shows 200/200 at limit", "blocks submit above limit"] });
    expect(getRun(detail.run.displayId).run.id).toBe(detail.run.id);
  });
  it("returns three commits for a successful implement and rejects unknown runs", () => {
    const run = getTicket("tkt_103").runs.find(r => r.stage === "implement" && r.state === "succeeded");
    if (!run) throw new Error("missing implement");
    expect(getRun(run.id).commits).toHaveLength(3);
    expect(() => getRun("missing")).toThrow("not found");
  });
});