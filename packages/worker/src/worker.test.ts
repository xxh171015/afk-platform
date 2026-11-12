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

describe("when the API fails", () => {
  it("logs a failed claim and claims again instead of exiting", async () => {
    const lines: string[] = [];
    const ac = new AbortController();
    let claims = 0;
    const api = {
      claim: async () => {
        claims += 1;
        if (claims === 1) throw new Error("claim failed: HTTP 500");
        ac.abort();
        return null;
      },
    } as unknown as WorkerApi;
    await runWorker({
      api,
      executor,
      pollMs: 5,
      retryMs: 5,
      signal: ac.signal,
      log: (line) => lines.push(line),
    });
    expect(claims).toBe(2);
    expect(lines.some((line) => line.includes("claim failed: HTTP 500"))).toBe(
      true,
    );
  });

  it("keeps going when reporting low disk to the API fails", async () => {
    const ac = new AbortController();
    let claims = 0;
    await runWorker({
      api: stubApi(() => {
        claims += 1;
        ac.abort();
      }),
      executor,
      pollMs: 5,
      retryMs: 5,
      signal: ac.signal,
      log: () => {},
      disk: {
        stopBelow: 5 * GIB,
        free: async () => 20 * GIB,
        report: async () => {
          throw new Error("the API answered 500");
        },
      },
    });
    expect(claims).toBe(1);
  });
});
