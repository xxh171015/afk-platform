import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo } from "@afk/pipeline/testing";
import { isNetworkPushError, TRIAL_MERGE_JOB } from "@afk/shared";
import { afterEach, describe, expect, it } from "vitest";
import { alignTicketBranch, originSha } from "./align-ticket-branch.ts";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { pushRef } from "./push.ts";
import { RepoStore } from "./repos.ts";
import { processJob, type WorkerOptions } from "./worker.ts";

// An origin that takes the connection and never answers: what a fetch saw in S-33 when the host's link to the
// code host came and went.
type HungOrigin = { url: string; open: () => number; server: Server };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function hungOrigin(): Promise<HungOrigin> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume(); // reads the request, or the end of a killed git would never be seen
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${port}/backend.git`,
    open: () => sockets.size,
    server,
  };
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A main clone made while origin answered, whose origin then stops answering.
function cloneThenHang(store: RepoStore, hung: HungOrigin): string {
  const seed = makeRepo({ "a.txt": "a\n" });
  cleanups.push(() => seed.cleanup());
  const dir = store.dirFor("backend", hung.url);
  gitOrThrow(tmp("afk-remote-"), ["clone", "--quiet", "--bare", seed.dir, dir]);
  gitOrThrow(dir, ["remote", "set-url", "origin", hung.url]);
  return dir;
}

const until = async (what: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!what() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return what();
};

const job: ClaimedJob = {
  id: 7,
  type: TRIAL_MERGE_JOB,
  payload: {},
  attempt: 1,
  lockKey: null,
  leaseExpiresAt: "2026-01-01T00:02:00Z",
};

// A worker whose only job fetches from the hung origin: no agent, no slot.
function trialMergeOn(
  hung: HungOrigin,
  store: RepoStore,
  heartbeat: (beat: number) => "held" | "lost",
) {
  const failures: string[] = [];
  let beats = 0;
  const api = {
    heartbeat: async () => heartbeat(++beats),
    trialMergeTask: async () => ({
      spec: { id: 1, displayId: "S-1", title: "A" },
      repo: { name: "backend", url: hung.url, defaultBranch: "main" },
      ours: { specId: 1, branch: "spec/a" },
      peers: [],
    }),
    fail: async (_job: ClaimedJob, error: string) => {
      failures.push(error);
    },
  } as unknown as WorkerApi;
  const executor = {
    repos: store,
    push: pushRef,
  } as unknown as WorkerOptions["executor"];
  return {
    failures,
    beats: () => beats,
    run: () => processJob({ api, executor, heartbeatMs: 20 }, job),
  };
}

describe("git that talks to origin", { timeout: 30_000 }, () => {
  it("goes on renewing the lease while a fetch hangs, and ends the fetch when the lease is gone", async () => {
    const hung = await hungOrigin();
    const store = new RepoStore(tmp("afk-repos-"));
    cloneThenHang(store, hung);
    // renews for a while, then the API says the lease is gone
    const worker = trialMergeOn(hung, store, (beat) =>
      beat < 10 ? "held" : "lost",
    );
    const outcome = worker.run();
    expect(await until(() => hung.open() > 0)).toBe(true);
    expect(await outcome).toBe("abandoned");
    // ten beats of 20 ms came while git was waiting on origin
    expect(worker.beats()).toBeGreaterThanOrEqual(10);
    expect(worker.failures).toEqual([]);
    // git was killed, so its connection is gone: nothing is left running
    expect(await until(() => hung.open() === 0)).toBe(true);
  });

  it("ends a fetch that runs past its limit and fails the job with an error read as a network error", async () => {
    const hung = await hungOrigin();
    const store = new RepoStore(tmp("afk-repos-"), undefined, {
      timeoutMs: 300,
    });
    cloneThenHang(store, hung);
    const worker = trialMergeOn(hung, store, () => "held");
    expect(await worker.run()).toBe("failed");
    expect(worker.failures).toHaveLength(1);
    expect(worker.failures[0]).toMatch(/git fetch .*timed out after 0.3s/);
    expect(isNetworkPushError(worker.failures[0] ?? "")).toBe(true);
    expect(await until(() => hung.open() === 0)).toBe(true);
  });

  it("ends a first clone that runs past its own limit", async () => {
    const hung = await hungOrigin();
    const store = new RepoStore(tmp("afk-repos-"), undefined, {
      cloneTimeoutMs: 300,
    });
    await expect(store.ensure("backend", hung.url, "main")).rejects.toThrow(
      /git clone .*timed out/,
    );
  });

  it("ends an ls-remote past its limit with an error, rather than taking the branch for missing", async () => {
    const hung = await hungOrigin();
    const dir = cloneThenHang(new RepoStore(tmp("afk-repos-")), hung);
    await expect(
      originSha(dir, "agent/T-1", { timeoutMs: 300 }),
    ).rejects.toThrow(/git ls-remote .*timed out/);
    await expect(
      alignTicketBranch(dir, "agent/T-1", { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
  });

  it("ends a push past its limit with a failure the stage waits out and pushes again", async () => {
    const hung = await hungOrigin();
    const dir = cloneThenHang(new RepoStore(tmp("afk-repos-")), hung);
    const pushed = await pushRef(
      {
        repoDir: dir,
        source: "refs/heads/main",
        target: "refs/heads/agent/T-1",
        expectedOld: "",
      },
      { timeoutMs: 300 },
    );
    expect(pushed.ok).toBe(false);
    expect(pushed.ok ? "" : pushed.error).toMatch(/git push timed out/);
    expect(isNetworkPushError(pushed.ok ? "" : pushed.error)).toBe(true);
  });

  it("ends a push when the job is given up", async () => {
    const hung = await hungOrigin();
    const dir = cloneThenHang(new RepoStore(tmp("afk-repos-")), hung);
    const stop = new AbortController();
    const pushing = pushRef({
      repoDir: dir,
      source: "refs/heads/main",
      target: "refs/heads/agent/T-1",
      expectedOld: "",
      signal: stop.signal,
    });
    expect(await until(() => hung.open() > 0)).toBe(true);
    stop.abort();
    const pushed = await pushing;
    expect(pushed.ok ? "" : pushed.error).toMatch(/the job was given up/);
    expect(await until(() => hung.open() === 0)).toBe(true);
  });
});
