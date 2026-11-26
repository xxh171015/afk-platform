import type { ReviewQuery } from "./review-search.ts";
import { pathMatches } from "./review-search.ts";

export type ReviewFileView = {
  id: number;
  path: string;
  oldPath: string | null;
  status: string;
  oldBlob: string;
  newBlob: string;
  additions: number;
  deletions: number;
  generated: boolean;
  test: boolean;
  lockfile: boolean;
  patchOmitted: string | null;
  attributions: { ticket?: string; run?: string; kind?: string }[];
  hunks:
    | {
        newStart: number;
        newLines: number;
        oldStart: number;
        oldLines: number;
        owners: { [key: string]: unknown }[];
      }[]
    | null;
  viewed: boolean;
};

export function ticketsOf(file: ReviewFileView): string[] {
  const ids: string[] = [];
  for (const item of file.attributions) {
    if (typeof item.ticket === "string" && item.ticket !== "") {
      ids.push(item.ticket);
    }
  }
  return [...new Set(ids)];
}

export function hunkTickets(
  owners: { [key: string]: unknown }[] | undefined,
): string[] {
  const ids: string[] = [];
  for (const owner of owners ?? []) {
    if (typeof owner.ticket === "string" && owner.ticket !== "") {
      ids.push(owner.ticket);
    }
  }
  return [...new Set(ids)];
}

export function ownerLabels(owners: { [key: string]: unknown }[]): string[] {
  const labels: string[] = [];
  for (const owner of owners) {
    if (typeof owner.ticket === "string") labels.push(owner.ticket);
    else if (typeof owner.run === "string") labels.push(owner.run);
    else if (owner.kind === "setup") labels.push("设置");
    else if (owner.kind === "planning") labels.push("规划");
    else if (owner.kind === "unknown") labels.push("未知");
  }
  return [...new Set(labels)];
}

export function fileMatches(
  file: ReviewFileView,
  query: ReviewQuery,
  sinceChanged: ReadonlySet<number>,
): boolean {
  if (query.unviewed && file.viewed) return false;
  if (query.commented) return false;
  if (query.drafts) return false;
  if (query.since && !sinceChanged.has(file.id)) return false;
  if (query.added && file.status !== "added") return false;
  if (query.deleted && file.status !== "deleted") return false;
  if (query.renamed && file.status !== "renamed") return false;
  if (query.tests && !file.test) return false;
  if (query["hide-generated"] && file.generated) return false;
  if (query.tickets.length > 0) {
    const have = ticketsOf(file);
    if (!query.tickets.some((ticket) => have.includes(ticket))) return false;
  }
  if (query.path) {
    const hit =
      pathMatches(file.path, query.path) ||
      (file.oldPath ? pathMatches(file.oldPath, query.path) : false);
    if (!hit) return false;
  }
  return true;
}

export function pullsInMergeOrder<T extends { id: number; repo: string }>(
  pulls: T[],
  ordered: string[],
  unordered: string[],
): T[] {
  const rank = (repo: string) => {
    const at = ordered.indexOf(repo);
    if (at >= 0) return at;
    const loose = unordered.indexOf(repo);
    if (loose >= 0) return ordered.length + loose;
    return ordered.length + unordered.length;
  };
  return [...pulls].sort((a, b) => rank(a.repo) - rank(b.repo) || a.id - b.id);
}

export type TicketGroup = {
  ticket: string | null;
  files: ReviewFileView[];
};

export function groupByTicket(
  files: ReviewFileView[],
  ticketOrder: string[],
): TicketGroup[] {
  const byTicket = new Map<string, ReviewFileView[]>();
  const none: ReviewFileView[] = [];
  for (const file of files) {
    const ids = ticketsOf(file);
    if (ids.length === 0) {
      none.push(file);
      continue;
    }
    for (const id of ids) {
      const list = byTicket.get(id) ?? [];
      list.push(file);
      byTicket.set(id, list);
    }
  }
  const groups: TicketGroup[] = [];
  const seen = new Set<string>();
  for (const id of ticketOrder) {
    const list = byTicket.get(id);
    if (!list) continue;
    groups.push({ ticket: id, files: list });
    seen.add(id);
  }
  for (const [id, list] of byTicket) {
    if (seen.has(id)) continue;
    groups.push({ ticket: id, files: list });
  }
  if (none.length > 0) groups.push({ ticket: null, files: none });
  return groups;
}

export function omittedReason(code: string | null): string | null {
  if (code === "too-large") return "文件太大，省略了 diff";
  if (code === "binary") return "二进制文件，没有 diff";
  if (code === "over-total") return "整份 diff 超上限，省略了这个文件";
  return code;
}

export function defaultFileOpen(
  file: ReviewFileView,
  selectedPath: string | undefined,
): boolean {
  if (file.path === selectedPath) return true;
  if (file.test && !file.generated && !file.lockfile) return true;
  return false;
}
