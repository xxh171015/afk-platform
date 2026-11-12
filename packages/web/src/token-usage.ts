function numberAt(
  row: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function tokenCounts(usage: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  if (usage === null || typeof usage !== "object") return {};
  const row = usage as Record<string, unknown>;
  return {
    inputTokens: numberAt(row, "inputTokens"),
    outputTokens: numberAt(row, "outputTokens"),
    cacheReadTokens: numberAt(row, "cacheReadTokens"),
    cacheWriteTokens: numberAt(row, "cacheWriteTokens"),
  };
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}
