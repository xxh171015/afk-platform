// Display ids are the prefix plus the serial primary key (S-12, T-123, R-456); they are not stored.
// docs/specs/m1-platform.md「数据模型」.
const PREFIXES = { spec: "S", ticket: "T", run: "R" } as const;
export type DisplayIdKind = keyof typeof PREFIXES;
export interface DisplayId {
  kind: DisplayIdKind;
  id: number;
}

const KIND_BY_PREFIX = new Map<string, DisplayIdKind>(
  (Object.keys(PREFIXES) as DisplayIdKind[]).map((kind) => [
    PREFIXES[kind],
    kind,
  ]),
);
const CANONICAL = new RegExp(
  `^([${Object.values(PREFIXES).join("")}])-([1-9][0-9]*)$`,
);

export function formatDisplayId(kind: DisplayIdKind, id: number): string {
  if (!Number.isInteger(id) || id < 1) {
    throw new RangeError(`a serial id is a positive integer, got ${id}`);
  }
  return `${PREFIXES[kind]}-${id}`;
}

// Only the canonical spelling is accepted: upper-case prefix, no leading zeros, nothing around it.
export function parseDisplayId(text: string): DisplayId | undefined {
  const match = CANONICAL.exec(text);
  if (!match) return undefined;
  const kind = KIND_BY_PREFIX.get(match[1] as string);
  const id = Number(match[2]);
  return kind && Number.isSafeInteger(id) ? { kind, id } : undefined;
}
