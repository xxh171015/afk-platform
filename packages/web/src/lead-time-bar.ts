import type { LeadTimeSegment } from "@afk/shared";

// The four 工期 segments, in the same state colors the rest of the page uses.
export const LEAD_TIME_BAR: { key: LeadTimeSegment; cls: string }[] = [
  { key: "agent", cls: "bg-state-running" },
  { key: "gate", cls: "bg-state-merging" },
  { key: "queued", cls: "bg-state-queued" },
  { key: "waiting", cls: "bg-state-paused" },
];
