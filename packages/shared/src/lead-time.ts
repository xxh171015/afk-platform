import { AGENT_FAILURES } from "./stage-flow.ts";

// Lead time (GLOSSARY 工期): wall clock from confirm to the last pull request merge, split into four
// non-overlapping segments. At any instant the first matching kind wins: agent, then 门禁, then 排队, then 等人.
// The four durations always sum to the span (docs/specs/m3-platform.md「工期四段与度量页」).

export const LEAD_TIME_SEGMENTS = [
  "agent",
  "gate",
  "queued",
  "waiting",
] as const;
export type LeadTimeSegment = (typeof LEAD_TIME_SEGMENTS)[number];

export type Span = { startMs: number; endMs: number | null };

export type LeadTime = {
  agentMs: number;
  gateMs: number;
  queuedMs: number;
  waitingMs: number;
  totalMs: number;
};

export type LeadTimeInput = {
  confirmAt: number;
  endAt: number;
  cancelled?: boolean;
  agent?: readonly Span[];
  gate?: readonly Span[];
  queued?: readonly Span[];
};

function covers(spans: readonly Span[], at: number, until: number): boolean {
  return spans.some((span) => {
    const start = span.startMs;
    const end = span.endMs ?? until;
    return start <= at && at < end;
  });
}

export function leadTime(input: LeadTimeInput): LeadTime | null {
  if (input.cancelled) return null;
  const from = input.confirmAt;
  const to = input.endAt;
  if (!(to >= from)) return null;
  const agent = input.agent ?? [];
  const gate = input.gate ?? [];
  const queued = input.queued ?? [];
  const points = new Set<number>([from, to]);
  for (const spans of [agent, gate, queued]) {
    for (const span of spans) {
      const start = Math.max(from, span.startMs);
      const end = Math.min(to, span.endMs ?? to);
      if (end > start) {
        points.add(start);
        points.add(end);
      }
    }
  }
  const times = [...points].sort((a, b) => a - b);
  const acc: LeadTime = {
    agentMs: 0,
    gateMs: 0,
    queuedMs: 0,
    waitingMs: 0,
    totalMs: to - from,
  };
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i] as number;
    const end = times[i + 1] as number;
    const mid = (start + end) / 2;
    const dur = end - start;
    if (covers(agent, mid, to)) acc.agentMs += dur;
    else if (covers(gate, mid, to)) acc.gateMs += dur;
    else if (covers(queued, mid, to)) acc.queuedMs += dur;
    else acc.waitingMs += dur;
  }
  return acc;
}

export const LEAD_TIME_LABELS: Record<LeadTimeSegment, string> = {
  agent: "agent",
  gate: "门禁",
  queued: "排队",
  waiting: "等人",
};

const AGENT_RUN_STAGES = new Set([
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "review",
  "diagnose",
  "final-review",
  "final-fix",
]);

const GATE_RUN_STAGES = new Set([
  "gate",
  "merge",
  "e2e",
  "final-merge",
  "final-e2e",
]);

const AGENT_RUN_RESULTS = new Set<string>(["done", ...AGENT_FAILURES]);

// Which of the four a Run belongs to. update-branch is the merge agent when the result is an agent
// outcome (or an agent is attached while it is still going); otherwise it is the locked merge, 门禁.
export function runLeadSegment(
  stage: string,
  result: string | null,
  hasAgent = false,
): LeadTimeSegment | null {
  if (AGENT_RUN_STAGES.has(stage)) return "agent";
  if (GATE_RUN_STAGES.has(stage)) return "gate";
  if (stage !== "update-branch") return null;
  if (result === null) return hasAgent ? "agent" : "gate";
  return AGENT_RUN_RESULTS.has(result) ? "agent" : "gate";
}
