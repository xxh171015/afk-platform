import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIB } from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { RepoStore } from "./repos.ts";
import { SlotManager } from "./slots.ts";
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

const hostJob: ClaimedJob = {
  id: 1,
  type: "host-sync",
  payload: {},
  attempt: 1,
  lockKey: null,
  leaseExpiresAt: "2026-01-01T00:02:00Z",
};

const host = { adapter: {} } as WorkerOptions["host"];

const until = async (what: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!what() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return what();
};

describe("when the API cannot be reached while a job is in hand", () => {
  it("hands the result in once the API returns, instead of abandoning after missed heartbeats", async () => {
    let heartbeats = 0;
    let apiUp = false;
    let releaseWork = () => {};
    const working = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const completed: unknown[] = [];
    const api = {
      heartbeat: async () => {
        heartbeats += 1;
        if (!apiUp) throw new Error("connection refused");
        return "held" as const;
      },
      hostTask: async () => {
        await working;
        return { kind: "host-sync" as const, pulls: [] };
      },
      complete: async (_job: ClaimedJob, body: unknown) => {
        completed.push(body);
        return "held" as const;
      },
    } as unknown as WorkerApi;
    const done = processJob({ api, executor, host, heartbeatMs: 20 }, hostJob);
    expect(await until(() => heartbeats >= 5)).toBe(true);
    apiUp = true;
    releaseWork();
    expect(await done).toBe("completed");
    expect(completed).toHaveLength(1);
  });

  it("abandons the job as soon as a heartbeat answers lost", async () => {
    let releaseWork = () => {};
    const working = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let heartbeats = 0;
    const api = {
      heartbeat: async () => {
        heartbeats += 1;
        return "lost" as const;
      },
      hostTask: async () => {
        await working;
        return { kind: "host-sync" as const, pulls: [] };
      },
      complete: async () => "held" as const,
    } as unknown as WorkerApi;
    const done = processJob({ api, executor, host, heartbeatMs: 20 }, hostJob);
    expect(await until(() => heartbeats >= 1)).toBe(true);
    // the run is aborted; hostTask is still waiting, so unblocking it lets processJob see the abort
    releaseWork();
    expect(await done).toBe("abandoned");
  });

  it("keeps handing in the result until the API answers, past the old three tries", async () => {
    let tries = 0;
    const api = {
      heartbeat: async () => "held" as const,
      hostTask: async () => ({ kind: "host-sync" as const, pulls: [] }),
      complete: async () => {
        tries += 1;
        if (tries < 5) throw new Error("connection refused");
        return "held" as const;
      },
    } as unknown as WorkerApi;
    expect(
      await processJob({ api, executor, host, heartbeatMs: 20 }, hostJob),
    ).toBe("completed");
    expect(tries).toBe(5);
  });

  it("stops handing in the result when the process is told to exit", async () => {
    const stop = new AbortController();
    let tries = 0;
    const api = {
      heartbeat: async () => "held" as const,
      hostTask: async () => ({ kind: "host-sync" as const, pulls: [] }),
      complete: async () => {
        tries += 1;
        if (tries === 2) stop.abort();
        throw new Error("connection refused");
      },
    } as unknown as WorkerApi;
    expect(
      await processJob(
        { api, executor, host, heartbeatMs: 20, signal: stop.signal },
        hostJob,
      ),
    ).toBe("abandoned");
    expect(tries).toBe(2);
  });
});

describe("log chunks while the API is unreachable", () => {
  const job: ClaimedJob = {
    id: 1,
    type: "agent-run",
    payload: {},
    attempt: 1,
    lockKey: null,
    leaseExpiresAt: "2026-01-01T00:02:00Z",
  };

  it("uploads chunks that failed while the API was down once it returns", async () => {
    const uploaded: string[] = [];
    let apiUp = false;
    let failedUploads = 0;
    const api = {
      heartbeat: async () => "held" as const,
      bundle: async () => ({
        run: { id: 7, displayId: "R-7" },
      }),
      appendLog: async (_runId: number, _job: ClaimedJob, chunk: string) => {
        if (!apiUp) {
          failedUploads += 1;
          throw new Error("connection refused");
        }
        uploaded.push(chunk);
        return "held" as const;
      },
      complete: async () => "held" as const,
    } as unknown as WorkerApi;
    const outcome = await processJob(
      {
        api,
        executor,
        heartbeatMs: 30,
        logFlushMs: 20,
        runStage: async ({ log }) => {
          log("hello from the agent");
          expect(await until(() => failedUploads >= 1)).toBe(true);
          apiUp = true;
          return { stage: "implement", outcome: "done" };
        },
      },
      job,
    );
    expect(outcome).toBe("completed");
    expect(uploaded.join("")).toContain("hello from the agent");
  });
});

describe("draining on SIGUSR2", () => {
  it("stops claiming after a drain, hands in the job in hand, and returns", {
    timeout: 3_000,
  }, async () => {
    let claims = 0;
    let releaseWork = () => {};
    const working = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const completed: unknown[] = [];
    const drain = new AbortController();
    const api = {
      claim: async () => {
        claims += 1;
        if (claims === 1) return hostJob;
        return null;
      },
      heartbeat: async () => "held" as const,
      hostTask: async () => {
        await working;
        return { kind: "host-sync" as const, pulls: [] };
      },
      complete: async (_job: ClaimedJob, body: unknown) => {
        completed.push(body);
        return "held" as const;
      },
    } as unknown as WorkerApi;
    const done = runWorker({
      api,
      executor,
      host,
      heartbeatMs: 30,
      pollMs: 5,
      drain: drain.signal,
    });
    expect(await until(() => claims >= 1)).toBe(true);
    drain.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const claimsAfterDrain = claims;
    releaseWork();
    await done;
    expect(completed).toHaveLength(1);
    expect(claims).toBe(claimsAfterDrain);
    expect(claims).toBe(1);
  });
});

describe("claiming when another process holds the slots", () => {
  let slotRoot: string | undefined;
  afterEach(() => {
    if (slotRoot) rmSync(slotRoot, { recursive: true, force: true });
    slotRoot = undefined;
  });

  it("does not claim a slot job when every slot is held, but still claims host-sync", async () => {
    slotRoot = mkdtempSync(join(tmpdir(), "afk-worker-slots-"));
    mkdirSync(join(slotRoot, "0"), { recursive: true });
    writeFileSync(
      join(slotRoot, "0", "lock"),
      JSON.stringify({
        jobId: 9,
        attempt: 1,
        pid: process.pid,
        repo: "backend",
        ref: "agent/T-9",
      }),
    );
    const slots = new SlotManager({
      root: slotRoot,
      count: 1,
      mainCloneFor: () => slotRoot as string,
      salvageDir: join(slotRoot, "salvage"),
      isHeld: async () => true,
    });
    const claimed: string[] = [];
    const takeSlot: Array<boolean | undefined> = [];
    const api = {
      claim: async (_capabilities: string[], opts?: { takeSlot?: boolean }) => {
        takeSlot.push(opts?.takeSlot);
        if (claimed.length > 0) return null;
        if (opts?.takeSlot === false) {
          claimed.push("host-sync");
          return hostJob;
        }
        claimed.push("agent-run");
        return {
          id: 2,
          type: "agent-run",
          payload: {},
          attempt: 1,
          lockKey: null,
          leaseExpiresAt: "2026-01-01T00:02:00Z",
        };
      },
      heartbeat: async () => "held" as const,
      hostTask: async () => ({ kind: "host-sync" as const, pulls: [] }),
      bundle: async () => ({ run: { id: 1, displayId: "R-1" } }),
      complete: async () => "held" as const,
    } as unknown as WorkerApi;
    await runWorker({
      api,
      executor: { ...executor, slots },
      host,
      stopWhenIdle: true,
      pollMs: 5,
      runStage: async () => ({ stage: "implement", outcome: "done" }),
    });
    expect(takeSlot[0]).toBe(false);
    expect(claimed).toEqual(["host-sync"]);
  });
});
