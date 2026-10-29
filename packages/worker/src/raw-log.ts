import { redactSecrets } from "@afk/shared";

// Cursor's event lines, on their way to the Run's log. They are uploaded as they are, apart from the worker's
// secrets and a cut for a line that is unreasonably long (a tool that printed a whole file); a stage uploads only so
// much of them in all. Everything is kept in full on the worker's disk.
export const MAX_RAW_LINE_CHARS = 16 * 1024;
export const MAX_RAW_LOG_BYTES = 8 * 1024 * 1024;

export function sanitizeRawLine(
  line: string,
  secrets: readonly string[],
): string {
  const clean = redactSecrets(line, secrets);
  return clean.length > MAX_RAW_LINE_CHARS
    ? `${clean.slice(0, MAX_RAW_LINE_CHARS)} [line cut]`
    : clean;
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
