// Display ids are the prefix plus the serial primary key (S-12, T-123, R-456); they are not stored.
// docs/specs/m1-platform.md「数据模型」.
const PREFIXES = { spec: "S", ticket: "T", run: "R" } as const;
export type DisplayIdKind = keyof typeof PREFIXES;

export function formatDisplayId(kind: DisplayIdKind, id: number): string {
  if (!Number.isInteger(id) || id < 1) {
    throw new RangeError(`a serial id is a positive integer, got ${id}`);
  }
  return `${PREFIXES[kind]}-${id}`;
}

const KIND_BY_PREFIX = Object.fromEntries(
  Object.entries(PREFIXES).map(([kind, prefix]) => [prefix, kind]),
) as Record<string, DisplayIdKind>;

// Only the canonical spelling is accepted: upper-case prefix, no leading zeros, nothing around it.
export function parseDisplayId(
  text: string,
): { kind: DisplayIdKind; id: number } | undefined {
  const match = /^([A-Z])-([1-9][0-9]*)$/.exec(text);
  const kind = match?.[1] ? KIND_BY_PREFIX[match[1]] : undefined;
  if (!match || !kind) return undefined;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind, id } : undefined;
}
