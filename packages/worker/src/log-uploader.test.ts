import { describe, expect, it, vi } from "vitest";
import { LOG_FLUSH_BYTES, LogUploader } from "./worker.ts";

describe("LogUploader", () => {
  it("uploads as soon as the buffer crosses 64 KiB, without waiting for flush()", async () => {
    const sent: string[] = [];
    const uploader = new LogUploader(async (chunk) => {
      sent.push(chunk);
    });
    const line = `${"a".repeat(1000)}\n`;
    const n = Math.ceil(LOG_FLUSH_BYTES / Buffer.byteLength(line));
    for (let i = 0; i < n; i++) uploader.add(line);
    await vi.waitFor(() => {
      expect(sent.join("").length).toBeGreaterThanOrEqual(LOG_FLUSH_BYTES);
    });
  });

  it("does not upload a small buffer until flush()", async () => {
    const sent: string[] = [];
    const uploader = new LogUploader(async (chunk) => {
      sent.push(chunk);
    });
    uploader.add("hello");
    await Promise.resolve();
    expect(sent).toEqual([]);
    await uploader.flush();
    expect(sent).toEqual(["hello\n"]);
  });

  it("puts a failed chunk back and uploads it on the next flush", async () => {
    const sent: string[] = [];
    let fail = true;
    const uploader = new LogUploader(async (chunk) => {
      if (fail) throw new Error("connection refused");
      sent.push(chunk);
    });
    uploader.add("hello");
    await uploader.flush().catch(() => undefined);
    expect(sent).toEqual([]);
    fail = false;
    await uploader.flush();
    expect(sent).toEqual(["hello\n"]);
  });

  it("drops the oldest buffered lines once the buffer is over 8 MiB", async () => {
    const sent: string[] = [];
    let fail = true;
    const uploader = new LogUploader(async (chunk) => {
      if (fail) throw new Error("connection refused");
      sent.push(chunk);
    });
    const payload = "x".repeat(64 * 1024);
    const lineBytes = Buffer.byteLength(`#0#${payload}\n`);
    const max = 8 * 1024 * 1024;
    const n = Math.ceil(max / lineBytes) + 2;
    for (let i = 0; i < n; i++) uploader.add(`#${i}#${payload}`);
    await uploader.flush().catch(() => undefined);
    fail = false;
    await uploader.flush();
    const text = sent.join("");
    expect(text).not.toContain("#0#");
    expect(text).toContain(`#${n - 1}#`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(max);
  });
});
