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
});
