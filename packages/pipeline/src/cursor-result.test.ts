import { describe, expect, it } from "vitest";
import { factsFromCursorLine, factsFromCursorLines } from "./cursor-result.ts";

const usage = {
  inputTokens: 143_000,
  outputTokens: 33_000,
  cacheReadTokens: 5_110_000,
  cacheWriteTokens: 12_000,
};

describe("factsFromCursorLine", () => {
  it("takes usage, API duration and CLI version from a result line, as they were written", () => {
    expect(
      factsFromCursorLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          duration_ms: 5000,
          duration_api_ms: 4200,
          cli_version: "2026.10.22-27dcf5f",
          usage,
        }),
      ),
    ).toEqual({
      tokenUsage: usage,
      durationApiMs: 4200,
      cursorCliVersion: "2026.10.22-27dcf5f",
    });
  });

  it("keeps usage even when CLI version and API duration are absent", () => {
    expect(
      factsFromCursorLine(JSON.stringify({ type: "result", usage })),
    ).toEqual({ tokenUsage: usage });
  });

  it("ignores a non-result line and a line that is not JSON", () => {
    expect(
      factsFromCursorLine(
        JSON.stringify({ type: "assistant", usage: { inputTokens: 1 } }),
      ),
    ).toBeUndefined();
    expect(factsFromCursorLine("implement: running the agent")).toBeUndefined();
  });
});

describe("factsFromCursorLines", () => {
  it("keeps the last result line, so a retry does not leave the first usage", () => {
    expect(
      factsFromCursorLines([
        JSON.stringify({ type: "result", usage: { inputTokens: 1 } }),
        JSON.stringify({
          type: "result",
          duration_api_ms: 9,
          usage: { inputTokens: 2 },
        }),
      ]),
    ).toEqual({ tokenUsage: { inputTokens: 2 }, durationApiMs: 9 });
  });

  it("is empty when the stream has no result line", () => {
    expect(
      factsFromCursorLines([
        JSON.stringify({ type: "system", subtype: "init" }),
        "gate: test exit 0",
      ]),
    ).toEqual({});
  });
});
