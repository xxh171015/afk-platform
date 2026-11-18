// Cursor's stream-json ends a successful print run with a `result` line. Usage,
// API duration and CLI version (when the CLI writes them) live on that line;
// Sandcastle's typed usage is empty, so we read the raw JSON (docs/optimization-plan.md 7.1).

export type CursorRunFacts = {
  tokenUsage?: unknown;
  durationApiMs?: number;
  cursorCliVersion?: string;
};

function parseCursorLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cursorLineOfType(
  line: string,
  type: string,
): Record<string, unknown> | undefined {
  const row = parseCursorLine(line);
  return row !== undefined && row.type === type ? row : undefined;
}

export function factsFromCursorLine(line: string): CursorRunFacts | undefined {
  const row = cursorLineOfType(line, "result");
  if (row === undefined) return undefined;
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

// The agent's last message, as the result line carries it: where the platform reads <result> again when
// Sandcastle could not (result-block.ts).
export function finalTextFromCursorLine(line: string): string | undefined {
  const row = cursorLineOfType(line, "result");
  return typeof row?.result === "string" ? row.result : undefined;
}

export function factsFromCursorLines(lines: readonly string[]): CursorRunFacts {
  let last: CursorRunFacts = {};
  for (const line of lines) {
    const next = factsFromCursorLine(line);
    if (next) last = next;
  }
  return last;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string" && content.length > 0) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return [(item as { text: string }).text];
    }
    return [];
  });
  const text = parts.join("");
  return text.length > 0 ? text : undefined;
}

export function lastAssistantFromCursorLine(line: string): string | undefined {
  const row = cursorLineOfType(line, "assistant");
  if (row === undefined) return undefined;
  const message = row.message;
  if (typeof message === "string" && message.length > 0) return message;
  if (message && typeof message === "object") {
    const text = contentText((message as { content?: unknown }).content);
    if (text) return text;
  }
  return contentText(row.content);
}

export function lastAssistantFromCursorLines(
  lines: readonly string[],
): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lastAssistantFromCursorLine(lines[i] ?? "");
    if (text) return text;
  }
  return undefined;
}
