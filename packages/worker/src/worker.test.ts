import { GIB } from "@afk/shared";
import { describe, expect, it } from "vitest";
import type { WorkerApi } from "./api.ts";
import { runWorker, type WorkerOptions } from "./worker.ts";

const executor = {} as WorkerOptions["executor"];

function stubApi(onClaim: () => void): WorkerApi {
  return {
    claim: async () => {
      onClaim();
      return null;
    },
  } as unknown as WorkerApi;
}

describe("claiming when the home disk is low", () => {
  it("does not claim below 5 GiB, then claims again once space recovers", async () => {
    const claims: number[] = [];
    const reports: number[] = [];
    const ac = new AbortController();
    let checks = 0;
    const run = runWorker({
      api: stubApi(() => {
        claims.push(1);
        ac.abort();
      }),
      executor,
      pollMs: 5,
      signal: ac.signal,
      disk: {
        stopBelow: 5 * GIB,
        free: async () => {
          checks += 1;
          return checks < 3 ? 4 * GIB : 20 * GIB;
        },
        report: async (free) => {
          reports.push(free);
        },
      },
    });
    await run;
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(claims).toHaveLength(1);
    expect(reports).toEqual([4 * GIB, 20 * GIB]);
  });
});
