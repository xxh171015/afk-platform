import { describe, expect, it } from "vitest";
import {
  MAX_RAW_LINE_CHARS,
  MAX_RAW_LOG_BYTES,
  rawLogSink,
  sanitizeRawLine,
} from "./raw-log.ts";

describe("sanitizeRawLine", () => {
  it("replaces every secret and leaves the rest of the line alone", () => {
    expect(
      sanitizeRawLine('{"env":"KEY=abc123 and abc123 again"}', ["abc123"]),
    ).toBe('{"env":"KEY=*** and *** again"}');
  });

  it("ignores an empty secret instead of mangling the line", () => {
    expect(sanitizeRawLine("plain", [""])).toBe("plain");
  });

  it("cuts a long line and says so, after the secret is gone, so a key cannot be cut in half", () => {
    const secret = "S".repeat(40);
    const line = `${"x".repeat(MAX_RAW_LINE_CHARS - 10)}${secret}${"y".repeat(100)}`;
    const cut = sanitizeRawLine(line, [secret]);
    expect(cut.endsWith(" [line cut]")).toBe(true);
    expect(cut).not.toContain("SSSS");
    expect(cut.length).toBe(MAX_RAW_LINE_CHARS + " [line cut]".length);
  });
});

describe("rawLogSink", () => {
  it("passes lines through until the limit, then says once that the rest is left out", () => {
    const sent: string[] = [];
    const sink = rawLogSink((line) => sent.push(line));
    const line = "a".repeat(MAX_RAW_LINE_CHARS);
    const fits = Math.floor(MAX_RAW_LOG_BYTES / (line.length + 1));
    for (let i = 0; i < fits + 20; i++) sink(line);
    expect(sent.filter((l) => l === line)).toHaveLength(fits);
    expect(sent.filter((l) => l.startsWith("[raw events beyond"))).toHaveLength(
      1,
    );
  });
});
