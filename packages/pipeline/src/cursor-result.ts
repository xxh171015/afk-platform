// Cursor's stream-json ends a successful print run with a `result` line. Usage,
// API duration and CLI version (when the CLI writes them) live on that line;
// Sandcastle's typed usage is empty, so we read the raw JSON (docs/optimization-plan.md 7.1).

export type CursorRunFacts = {
  tokenUsage?: unknown;
  durationApiMs?: number;
  cursorCliVersion?: string;
};

export function factsFromCursorLine(line: string): CursorRunFacts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("type" in parsed) ||
    parsed.type !== "result"
  ) {
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  const facts: CursorRunFacts = {};
  if ("usage" in row) facts.tokenUsage = row.usage;
  if (
    typeof row.duration_api_ms === "number" &&
    Number.isFinite(row.duration_api_ms)
  ) {
    facts.durationApiMs = Math.max(0, Math.round(row.duration_api_ms));
  }
  const version = row.cli_version;
  if (typeof version === "string" && version.length > 0) {
    facts.cursorCliVersion = version;
  }
  return facts;
}

export function factsFromCursorLines(lines: readonly string[]): CursorRunFacts {
  let last: CursorRunFacts = {};
  for (const line of lines) {
    const next = factsFromCursorLine(line);
    if (next) last = next;
  }
  return last;
}
