import { describe, expect, it } from "vitest";
import type { WorkerApi } from "./api.ts";
import { runWorker, type WorkerOptions } from "./worker.ts";

// A claim that fails (the API restarting, a reset connection) must not take the worker down with the jobs
// the other slots are running: the loop says so, waits, and claims again.

describe("the claim loop", () => {
  it("logs a failed claim and claims again instead of stopping the worker", async () => {
    let claims = 0;
    const api = {
      claim: async () => {
        claims += 1;
        if (claims === 1) throw new TypeError("fetch failed");
        return null;
      },
    } as unknown as WorkerApi;
    const lines: string[] = [];
    const run = await runWorker({
      api,
      executor: {} as WorkerOptions["executor"],
      stopWhenIdle: true,
      pollMs: 1,
      log: (line) => lines.push(line),
    });
    expect(run.jobs).toBe(0);
    expect(claims).toBe(2);
    expect(lines.join("\n")).toContain("claim failed: TypeError: fetch failed");
  });
});
