// How the platform writes an acceptance pack into a pull request description: a marked section the next
// PATCH may replace, leaving whatever a person wrote outside it (docs/specs/experience-platform.md「验收包进 PR」).

export const PACK_MARK_START = "<!-- afk-acceptance-pack -->";
export const PACK_MARK_END = "<!-- /afk-acceptance-pack -->";

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
