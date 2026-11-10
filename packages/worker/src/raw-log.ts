import { redactSecrets } from "@afk/shared";

// Cursor's event lines, on their way to the Run's log. They are uploaded as they are, apart from the worker's
// secrets and a compact pass for a line that is unreasonably long (a tool that printed a whole file); a stage
// uploads only so much of them in all. Everything is kept in full on the worker's disk.
export const MAX_RAW_LINE_CHARS = 16 * 1024;
export const MAX_RAW_LOG_BYTES = 8 * 1024 * 1024;

const LINE_CUT_SUFFIX = " [line cut]";
const TRUNCATED_MARK = "\n…(已截断)";

export function sanitizeRawLine(
  line: string,
  secrets: readonly string[],
): string {
  const clean = redactSecrets(line, secrets);
  if (clean.length <= MAX_RAW_LINE_CHARS) return clean;
  const parsed = parseJsonObject(clean);
  if (parsed) {
    const compacted = compactCursorEvent(parsed);
    const serialized = JSON.stringify(compacted);
    if (serialized.length <= MAX_RAW_LINE_CHARS) return serialized;
  }
  return `${clean.slice(0, MAX_RAW_LINE_CHARS)}${LINE_CUT_SUFFIX}`;
}

// The log channel for the raw events of one stage: capped in total, and saying so only once.
export function rawLogSink(
  add: (line: string) => void,
): (line: string) => void {
  let bytes = 0;
  let capped = false;
  return (line) => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes <= MAX_RAW_LOG_BYTES) return add(line);
    if (capped) return;
    capped = true;
    add("[raw events beyond the size limit are not uploaded]");
  };
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function compactCursorEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  dropRedundantInterleaved(clone);
  if (JSON.stringify(clone).length <= MAX_RAW_LINE_CHARS) return clone;
  shrinkResultStrings(clone);
  if (JSON.stringify(clone).length <= MAX_RAW_LINE_CHARS) return clone;
  dropResultBodies(clone);
  return clone;
}

function dropRedundantInterleaved(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) dropRedundantInterleaved(item);
    return;
  }
  const record = node as Record<string, unknown>;
  if (
    typeof record.stdout === "string" &&
    record.stdout !== "" &&
    "interleavedOutput" in record
  ) {
    delete record.interleavedOutput;
  }
  for (const value of Object.values(record)) dropRedundantInterleaved(value);
}

function shrinkResultStrings(event: Record<string, unknown>): void {
  const fields: { obj: Record<string, unknown>; key: string; value: string }[] =
    [];
  collectShrinkable(event, "", fields);
  fields.sort((a, b) => b.value.length - a.value.length);
  let json = JSON.stringify(event);
  for (const field of fields) {
    if (json.length <= MAX_RAW_LINE_CHARS) break;
    const overflow = json.length - MAX_RAW_LINE_CHARS;
    const keep = Math.max(
      0,
      field.value.length - overflow - TRUNCATED_MARK.length - 64,
    );
    field.obj[field.key] =
      keep === 0
        ? TRUNCATED_MARK.trim()
        : field.value.slice(0, keep) + TRUNCATED_MARK;
    json = JSON.stringify(event);
  }
}

function collectShrinkable(
  node: unknown,
  path: string,
  out: { obj: Record<string, unknown>; key: string; value: string }[],
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      collectShrinkable(item, `${path}[${i}]`, out);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const next = path === "" ? key : `${path}.${key}`;
    if (typeof value === "string") {
      if (
        value.length > 256 &&
        key !== "call_id" &&
        key !== "session_id" &&
        !next.includes(".args.") &&
        !next.endsWith(".args")
      ) {
        out.push({ obj: record, key, value });
      }
      continue;
    }
    collectShrinkable(value, next, out);
  }
}

function dropResultBodies(event: Record<string, unknown>): void {
  const tool = event.tool_call;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
  for (const value of Object.values(tool as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const inner = value as Record<string, unknown>;
    if ("result" in inner) inner.result = { truncated: true };
  }
}
