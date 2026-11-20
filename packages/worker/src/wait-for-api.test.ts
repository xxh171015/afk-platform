import { describe, expect, it } from "vitest";
import { waitForApi } from "./wait-for-api.ts";

// A worker started while the API is down (a restart.sh api that failed, the API still coming up) waits for it
// instead of exiting: under up.sh a worker that exits stops the whole stack.

function api(answers: ("down" | number)[]) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const next = answers.shift() ?? 200;
    if (next === "down") throw new TypeError("fetch failed");
    return { ok: next >= 200 && next < 300, status: next };
  };
  return { calls, fetch };
}

describe("waitForApi", () => {
  it("returns at once, without a line, when the API answers", async () => {
    const { calls, fetch } = api([200]);
    const lines: string[] = [];
    const waits: number[] = [];
    await waitForApi({
      apiUrl: "http://127.0.0.1:3000",
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (line) => lines.push(line),
    });
    expect(calls).toEqual(["http://127.0.0.1:3000/specs"]);
    expect(lines).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("keeps trying while the API is down or answers with an error, says why once, and returns when it answers", async () => {
    const { calls, fetch } = api(["down", 503, "down", 200]);
    const lines: string[] = [];
    const waits: number[] = [];
    await waitForApi({
      apiUrl: "http://127.0.0.1:3000",
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(4);
    expect(waits).toHaveLength(3);
    expect(lines[0]).toMatch(
      /the API at http:\/\/127\.0\.0\.1:3000 does not answer \(fetch failed\)/,
    );
    expect(lines[0]).toMatch(/waiting/);
    expect(lines.filter((line) => /does not answer/.test(line))).toHaveLength(
      1,
    );
    expect(lines.at(-1)).toMatch(/the API answers/);
  });

  it("backs off between tries, up to a cap", async () => {
    const { fetch } = api(Array(12).fill("down"));
    const waits: number[] = [];
    await waitForApi({
      apiUrl: "http://127.0.0.1:3000",
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    expect(waits[0]).toBeLessThan(waits[3]);
    expect(Math.max(...waits)).toBe(waits.at(-1));
    expect(new Set(waits.slice(-3)).size).toBe(1);
  });
});
