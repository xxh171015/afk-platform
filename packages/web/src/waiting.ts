import { formatShanghaiTime } from "./time.ts";

// How many items sit in the waiting queue: the nav badge and the workbench 等你处理 quadrant share this.

export function waitingCount(queue: {
  tickets: readonly unknown[];
  finalizations: readonly unknown[];
  pullRequests: readonly unknown[];
  cleanups: readonly unknown[];
  readyFailures: readonly unknown[];
  planning?: readonly unknown[];
  specs: readonly unknown[];
}): number {
  return (
    queue.tickets.length +
    queue.finalizations.length +
    queue.pullRequests.length +
    queue.cleanups.length +
    queue.readyFailures.length +
    (queue.planning?.length ?? 0) +
    queue.specs.length
  );
}

export interface Blocking {
  downstream: string[];
  finalization: boolean;
  pullRequests: boolean;
  spec: boolean;
  merge: boolean;
}

export type WaitingRef =
  | { kind: "ticket"; id: number }
  | { kind: "finalization"; id: number; step: string }
  | { kind: "pullRequest"; specId: number; repo: string; number: number }
  | { kind: "cleanup"; specId: number }
  | { kind: "readyFailure"; specId: number; repo: string; number: number }
  | { kind: "planning"; specId: number }
  | { kind: "pausedSpec"; id: number };

export function rankOf(blocking: Blocking): number {
  if (blocking.downstream.length > 0) return 0;
  if (blocking.finalization || blocking.pullRequests) return 1;
  if (blocking.spec || blocking.merge) return 2;
  return 3;
}

export function blockingCopy(blocking: Blocking): string {
  const parts: string[] = [];
  if (blocking.downstream.length > 0)
    parts.push(`挡住 ${blocking.downstream.join("、")}`);
  if (blocking.finalization) parts.push("收尾未开始");
  if (blocking.pullRequests) parts.push("挡住开 PR");
  if (blocking.spec) parts.push("挡住整份需求");
  if (blocking.merge) parts.push("挡住合并进 main");
  return parts.length > 0 ? parts.join("；") : "不挡住其他票";
}

export function rankCopy(blocking: Blocking, waitingSince: string): string {
  const since = formatShanghaiTime(waitingSince);
  const rank = rankOf(blocking);
  if (rank === 0) return `排在前面：挡住尚未完成的下游票。从 ${since} 起等。`;
  if (rank === 1) return `排在这：挡住收尾或开 PR。从 ${since} 起等。`;
  if (rank === 2)
    return `排在这：挡住整份需求或合并进 main。从 ${since} 起等。`;
  return `排在这：没有挡住其他事项。从 ${since} 起等。`;
}

export function matchesFinalization(
  item: { id: number; step: string },
  ref: Extract<WaitingRef, { kind: "finalization" }>,
): boolean {
  return item.id === ref.id && item.step === ref.step;
}

export function filterWaiting(
  items: WaitingRef[],
  type: "all" | "tickets" | "final" | "pr" | "cleanup" | "paused",
): WaitingRef[] {
  if (type === "all") return items;
  if (type === "tickets") return items.filter((item) => item.kind === "ticket");
  if (type === "final")
    return items.filter((item) => item.kind === "finalization");
  if (type === "pr")
    return items.filter(
      (item) => item.kind === "pullRequest" || item.kind === "readyFailure",
    );
  if (type === "cleanup")
    return items.filter((item) => item.kind === "cleanup");
  return items.filter(
    (item) => item.kind === "pausedSpec" || item.kind === "planning",
  );
}

export function groupWaitingBySpec<T extends WaitingRef>(
  items: T[],
  specIdOf: (item: T) => number,
  rankOfItem: (item: T) => {
    rank: number;
    waitingSince: string;
    serialId: number;
  },
): T[] {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const specId = specIdOf(item);
    const list = groups.get(specId) ?? [];
    list.push(item);
    groups.set(specId, list);
  }
  return [...groups.values()]
    .sort((a, b) => {
      const best = (group: T[]) =>
        group.reduce(
          (acc, item) => {
            const current = rankOfItem(item);
            if (current.rank !== acc.rank) {
              return current.rank < acc.rank ? current : acc;
            }
            const waited = current.waitingSince.localeCompare(acc.waitingSince);
            if (waited !== 0) return waited < 0 ? current : acc;
            return current.serialId < acc.serialId ? current : acc;
          },
          rankOfItem(group[0] as T),
        );
      const left = best(a);
      const right = best(b);
      if (left.rank !== right.rank) return left.rank - right.rank;
      const waited = left.waitingSince.localeCompare(right.waitingSince);
      if (waited !== 0) return waited;
      return left.serialId - right.serialId;
    })
    .flat();
}
