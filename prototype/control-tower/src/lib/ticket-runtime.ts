import type { Finding, Run, RunLogsResponse } from "@/api/types";
export const AGENT_STAGES = ["implement", "review", "gate-fix", "review-fix", "merge-fix"];
export function agentRunCount(runs: Run[]) { return runs.filter(r => AGENT_STAGES.includes(r.stage)).length; }
export function findingGroup(f: Finding) { return f.axis ?? ((f.kind ?? f.source) === "gate" ? "门禁" : "其他"); }
export interface LogBuffer { text: string; offset: number; attempt: number | null; finished: boolean; restarted: boolean }
export const emptyLogBuffer = (): LogBuffer => ({ text: "", offset: 0, attempt: null, finished: false, restarted: false });
export function appendLogChunk(previous: LogBuffer, chunk: RunLogsResponse): LogBuffer {
  const changed = previous.attempt !== null && previous.attempt !== chunk.attempt;
  if (changed && chunk.offset !== 0) return { ...emptyLogBuffer(), attempt: chunk.attempt, restarted: true };
  if (!changed && chunk.offset !== previous.offset) return previous;
  return { text: (changed ? "" : previous.text) + chunk.text, offset: chunk.nextOffset, attempt: chunk.attempt, finished: chunk.finished, restarted: changed || previous.restarted };
}