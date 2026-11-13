import { GIB } from "@afk/shared";
import { describe, expect, it } from "vitest";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { RepoStore } from "./repos.ts";
import { processJob, runWorker, type WorkerOptions } from "./worker.ts";

const executor = {
  repos: new RepoStore("/nonexistent"),
  push: async () => ({ ok: true }),
} as unknown as WorkerOptions["executor"];

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

describe("heartbeats while a job is in hand", () => {
  const job: ClaimedJob = {
    id: 1,
    type: "agent-run",
    payload: {},
    attempt: 1,
    lockKey: null,
    leaseExpiresAt: "2026-01-01T00:02:00Z",
  };

  it("does not return while a heartbeat is still in flight", async () => {
    let releaseHeartbeat = () => {};
    const heartbeatHeld = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let heartbeatStarted = false;
    let releaseBundle = () => {};
    const bundleHeld = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    const api = {
      heartbeat: async () => {
        heartbeatStarted = true;
        await heartbeatHeld;
        return "held" as const;
      },
      bundle: async () => {
        await bundleHeld;
        return "lost" as const;
      },
    } as unknown as WorkerApi;
    const done = processJob({ api, executor, heartbeatMs: 20 }, job);
    const deadline = Date.now() + 1_000;
    while (!heartbeatStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(heartbeatStarted).toBe(true);
    let finished = false;
    const finishedAt = done.then(() => {
      finished = true;
    });
    releaseBundle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(finished).toBe(false);
    releaseHeartbeat();
    await finishedAt;
    expect(finished).toBe(true);
  });
});
