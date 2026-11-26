import { paths } from "./paths.ts";

export type ReviewView = "guide" | "all" | "since";

export type ReviewSearch = {
  pr?: number;
  file?: string;
  view?: ReviewView;
  q?: string;
};

const FLAGS = [
  "unviewed",
  "commented",
  "drafts",
  "since",
  "added",
  "deleted",
  "renamed",
  "tests",
  "hide-generated",
] as const;

export type ReviewFlag = (typeof FLAGS)[number];

export type ReviewQuery = {
  path: string;
  tickets: string[];
} & Record<ReviewFlag, boolean>;

export function reviewSearch(raw: unknown): ReviewSearch {
  const s =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const prRaw = s.pr;
  const pr =
    typeof prRaw === "number" && Number.isInteger(prRaw) && prRaw > 0
      ? prRaw
      : typeof prRaw === "string" && /^[1-9][0-9]*$/.test(prRaw)
        ? Number(prRaw)
        : undefined;
  const view: ReviewView | undefined =
    s.view === "all" || s.view === "since" || s.view === "guide"
      ? s.view
      : undefined;
  return {
    ...(pr !== undefined ? { pr } : {}),
    ...(typeof s.file === "string" && s.file !== "" ? { file: s.file } : {}),
    ...(view ? { view } : {}),
    ...(typeof s.q === "string" && s.q !== "" ? { q: s.q } : {}),
  };
}

export function reviewViewOf(search: ReviewSearch): ReviewView {
  return search.view ?? "guide";
}

export function emptyQuery(): ReviewQuery {
  return {
    path: "",
    tickets: [],
    unviewed: false,
    commented: false,
    drafts: false,
    since: false,
    added: false,
    deleted: false,
    renamed: false,
    tests: false,
    "hide-generated": false,
  };
}

export function parseReviewQuery(q: string | undefined): ReviewQuery {
  const next = emptyQuery();
  if (!q) return next;
  const pathParts: string[] = [];
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if ((FLAGS as readonly string[]).includes(token)) {
      next[token as ReviewFlag] = true;
    } else if (token.startsWith("ticket:")) {
      const id = token.slice("ticket:".length);
      if (id) next.tickets.push(id);
    } else {
      pathParts.push(token);
    }
  }
  next.path = pathParts.join(" ");
  return next;
}

export function serializeReviewQuery(query: ReviewQuery): string | undefined {
  const parts: string[] = [];
  for (const flag of FLAGS) {
    if (query[flag]) parts.push(flag);
  }
  for (const ticket of query.tickets) parts.push(`ticket:${ticket}`);
  if (query.path.trim()) parts.push(query.path.trim());
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function reviewHref(
  specId: number | string,
  search: ReviewSearch,
): string {
  const params = new URLSearchParams();
  if (search.pr != null) params.set("pr", String(search.pr));
  if (search.file) params.set("file", search.file);
  if (search.view && search.view !== "guide") params.set("view", search.view);
  if (search.q) params.set("q", search.q);
  const qs = params.toString();
  return qs ? `${paths.specReview(specId)}?${qs}` : paths.specReview(specId);
}

export function pathMatches(path: string, glob: string): boolean {
  const trimmed = glob.trim();
  if (!trimmed) return true;
  if (!trimmed.includes("*")) return path.includes(trimmed);
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return (
    new RegExp(`^${escaped}$`).test(path) || new RegExp(escaped).test(path)
  );
}
