import type { InvalidatePayload } from "@afk/shared";

export type { InvalidatePayload };

// Resource queries poll only while SSE is down. Tests that never mount EventsProvider keep refetchInterval
// off, so they do not depend on a timer.
export function resourcePollMs(
  connected: boolean,
  disconnectedMs: number,
): number | false {
  return connected ? false : disconnectedMs;
}

export const LIST_POLL_MS = 5_000;
export const DETAIL_POLL_MS = 3_000;

export function queryKeysForInvalidate(
  payload: InvalidatePayload,
): readonly (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [["workbench"], ["blocked"]];
  if (payload.specId !== undefined) {
    keys.push(
      ["spec", payload.specId],
      ["specs"],
      ["search"],
      ["projects"],
      ["project"],
    );
  }
  if (payload.ticketId !== undefined) {
    keys.push(["ticket", payload.ticketId]);
  }
  if (payload.runId !== undefined) {
    keys.push(["log", payload.runId], ["run", payload.runId]);
  }
  return keys;
}
