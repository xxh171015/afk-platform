import { HOST_JOB_TYPES, TRIAL_MERGE_JOB } from "./host-jobs.ts";
import { PLANNING_COMMIT_JOB } from "./planning-docs.ts";

// `plat repo check` (operations manual 1.3): a worker runs a repo's gate on a pushed branch.
export const READINESS_GATE_JOB = "readiness-gate";

// Jobs that do not take a worker Slot (no sandbox clone). Claim may still hand these out when
// takeSlot is false; agent-run and the other slot jobs wait for a free Slot.
export const SLOTLESS_JOB_TYPES: readonly string[] = [
  ...HOST_JOB_TYPES,
  TRIAL_MERGE_JOB,
  PLANNING_COMMIT_JOB,
  READINESS_GATE_JOB,
];

export function occupiesSlot(type: string): boolean {
  return !SLOTLESS_JOB_TYPES.includes(type);
}
