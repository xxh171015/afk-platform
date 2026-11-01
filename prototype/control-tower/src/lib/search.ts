export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX_LENGTH = 200;
export const RECENT_VISITS_KEY = "afk:recent-visits";

export interface RecentVisit {
  kind: "spec" | "ticket" | "run";
  id: string;
  displayId: string;
  title: string;
  ticketId?: string | null;
  specId?: string;
}

export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let offset = 0;
  while (offset < text.length) {
    const at = text.toLowerCase().indexOf(needle, offset);
    if (at < 0) { parts.push({ text: text.slice(offset), match: false }); break; }
    if (at > offset) parts.push({ text: text.slice(offset, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    offset = at + needle.length;
  }
  return parts;
}

export function bodyExcerpt(text: string, query: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(query.trim().toLowerCase()));
  const start = Math.max(0, at - 24);
  const end = Math.min(text.length, at + query.trim().length + 48);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function readRecentVisits(): RecentVisit[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(RECENT_VISITS_KEY) ?? "[]");
    if (!Array.isArray(entries)) return [];
    return entries.filter((v): v is RecentVisit => v && ["spec", "ticket", "run"].includes(v.kind) && typeof v.id === "string" && typeof v.displayId === "string" && typeof v.title === "string" && (v.kind !== "run" || typeof v.ticketId === "string" || typeof v.specId === "string")).slice(0, 8);
  } catch { return []; }
}

export function recordVisit(visit: RecentVisit) {
  try {
    const entries = readRecentVisits().filter(v => v.kind !== visit.kind || v.id !== visit.id);
    const label: RecentVisit = { kind: visit.kind, id: visit.id, displayId: visit.displayId, title: visit.title, ...(visit.kind === "run" ? { ticketId: visit.ticketId, specId: visit.specId } : {}) };
    localStorage.setItem(RECENT_VISITS_KEY, JSON.stringify([label, ...entries].slice(0, 8)));
  } catch { /* Search remains usable when browser storage is unavailable. */ }
}