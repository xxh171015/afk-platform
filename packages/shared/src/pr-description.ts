// How the platform writes an acceptance pack into a pull request description: a marked section the next
// PATCH may replace, leaving whatever a person wrote outside it (docs/specs/experience-platform.md「验收包进 PR」).

export const PACK_MARK_START = "<!-- afk-acceptance-pack -->";
export const PACK_MARK_END = "<!-- /afk-acceptance-pack -->";

// The merge-policy sentence in an open-pr description: the auto-merge host task
// replaces this marked block before it merges (ADR 0011).
export const MERGE_NOTE_MARK_START = "<!-- afk:merge-note -->";
export const MERGE_NOTE_MARK_END = "<!-- /afk:merge-note -->";
export const MANUAL_MERGE_NOTE =
  "Merging is up to you; the platform never merges.";
export const AUTO_IMPROVEMENT_MERGE_NOTE =
  "满足条件时平台会在 30 分钟后自动合并，在 PR 上写评论即可阻止";
export const AUTO_MERGED_MARK = "<!-- afk:auto-merged -->";
export const REVIEW_NOTE_MARKER = "<!-- afk:review-notes -->";
export const AUTO_MERGED_NOTE = "平台已自动合并";
export const AUTO_MERGED_SECTION = `${AUTO_MERGED_MARK}\n${AUTO_MERGED_NOTE}`;

export function wrapMergeNote(note: string): string {
  return `${MERGE_NOTE_MARK_START}\n${note}\n${MERGE_NOTE_MARK_END}`;
}

// Replaces the marked merge-note with `section`, leaving what a person wrote outside it.
export function spliceMergeNote(existing: string, section: string): string {
  const start = existing.indexOf(MERGE_NOTE_MARK_START);
  const end = existing.indexOf(MERGE_NOTE_MARK_END);
  if (start >= 0 && end > start) {
    const after = end + MERGE_NOTE_MARK_END.length;
    const before = existing.slice(0, start).trimEnd();
    const rest = existing.slice(after).replace(/^\n/, "");
    return [before, section, rest.trimStart()].filter(Boolean).join("\n\n");
  }
  const body = existing.trimEnd();
  return body ? `${body}\n\n${section}` : section;
}

// GitHub's pull request body limit. Past this the marked section is a summary and a link to the spec.
export const GITHUB_PR_BODY_LIMIT = 65_536;

export function wrapPackSection(section: string): string {
  return `${PACK_MARK_START}\n${section.trim()}\n${PACK_MARK_END}`;
}

export function splicePackSection(existing: string, section: string): string {
  const wrapped = wrapPackSection(section);
  const start = existing.indexOf(PACK_MARK_START);
  const end = existing.indexOf(PACK_MARK_END);
  if (start >= 0 && end > start) {
    const after = end + PACK_MARK_END.length;
    const before = existing.slice(0, start).trimEnd();
    const rest = existing.slice(after).replace(/^\n/, "");
    return [before, wrapped, rest.trimStart()].filter(Boolean).join("\n\n");
  }
  const body = existing.trimEnd();
  return body ? `${body}\n\n${wrapped}` : wrapped;
}

export function fitPrDescription(
  full: string,
  summarized: string,
  summaryOnly: string,
): string {
  if (full.length <= GITHUB_PR_BODY_LIMIT) return full;
  if (summarized.length <= GITHUB_PR_BODY_LIMIT) return summarized;
  // last resort: the summary still goes in markers so the next PATCH can find them
  const wrapped = wrapPackSection(summaryOnly);
  return wrapped.length <= GITHUB_PR_BODY_LIMIT
    ? wrapped
    : wrapped.slice(0, GITHUB_PR_BODY_LIMIT);
}
