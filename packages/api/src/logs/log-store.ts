import { appendFile, mkdir, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Run logs as plain files, one per (run, attempt): <dir>/run-<run id>/attempt-<n>.log. A new attempt of a job
// (its lease ran out and another worker took over) starts a fresh file, so a log never mixes two executions.
// The HTTP interface does not depend on this being a directory: M3 swaps the store for MinIO.

export const MAX_LOG_BYTES = 50 * 1024 * 1024; // per run attempt
export const MAX_CHUNK_BYTES = 1024 * 1024;

export const defaultLogDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.AFK_LOG_DIR ?? join(homedir(), ".afk", "logs");

const isNotFound = (error: unknown) =>
  (error as { code?: string }).code === "ENOENT";

export interface LogSlice {
  text: string;
  offset: number; // where this slice starts, in bytes
  nextOffset: number; // where to continue
  size: number; // bytes in the file now
}

export type AppendResult =
  | { status: "ok"; size: number }
  | { status: "too-large"; size: number };

export class LogStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  // Appends to one file run one after another, so the size check and the write cannot interleave.
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(dir: string, maxBytes = MAX_LOG_BYTES) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  private file(runId: number, attempt: number) {
    return join(this.dir, `run-${runId}`, `attempt-${attempt}.log`);
  }

  async append(
    runId: number,
    attempt: number,
    chunk: string,
  ): Promise<AppendResult> {
    const key = this.file(runId, attempt);
    const turn = (this.pending.get(key) ?? Promise.resolve()).then(() =>
      this.appendNow(runId, attempt, chunk),
    );
    const settled = turn.catch(() => undefined);
    this.pending.set(key, settled);
    try {
      return await turn;
    } finally {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    }
  }

  private async appendNow(
    runId: number,
    attempt: number,
    chunk: string,
  ): Promise<AppendResult> {
    const bytes = Buffer.byteLength(chunk);
    const size = await this.size(runId, attempt);
    if (size + bytes > this.maxBytes) return { status: "too-large", size };
    await mkdir(join(this.dir, `run-${runId}`), { recursive: true });
    await appendFile(this.file(runId, attempt), chunk);
    return { status: "ok", size: size + bytes };
  }

  async size(runId: number, attempt: number): Promise<number> {
    try {
      return (await stat(this.file(runId, attempt))).size;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  // The newest attempt that has written anything, if any.
  async latestAttempt(runId: number): Promise<number | undefined> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, `run-${runId}`));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const attempts = names
      .map((name) => /^attempt-(\d+)\.log$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    return attempts.length > 0 ? Math.max(...attempts) : undefined;
  }

  // Reads from a byte offset. The slice ends on a character boundary, so a reader that continues from
  // nextOffset never sees half a character.
  async read(
    runId: number,
    attempt: number,
    offset: number,
    limit: number,
  ): Promise<LogSlice> {
    const size = await this.size(runId, attempt);
    if (offset >= size) return { text: "", offset, nextOffset: offset, size };
    const handle = await open(this.file(runId, attempt), "r");
    try {
      const wanted = Math.min(limit, size - offset);
      const buffer = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
      let end = bytesRead;
      // Back off over a partial multi-byte character at the cut. This also holds at the end of the file: an
      // append that is still being written may have put down only the first bytes of a character.
      const cut = end;
      let lead = end - 1;
      while (lead >= 0 && ((buffer[lead] as number) & 0xc0) === 0x80) lead--;
      if (lead >= 0) {
        const first = buffer[lead] as number;
        const length =
          first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (end - lead < length) end = lead;
      }
      // A limit smaller than one character: hand out the raw bytes rather than never advancing.
      if (end === 0 && offset + cut < size) end = cut;
      return {
        text: buffer.subarray(0, end).toString("utf8"),
        offset,
        nextOffset: offset + end,
        size,
      };
    } finally {
      await handle.close();
    }
  }
}
