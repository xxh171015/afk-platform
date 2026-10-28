import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  type ClaimedJob,
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
} from "../test/fake-worker.ts";
import { enqueueJob } from "./queue.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(createApp({ pool: db.pool, clock: clock.now }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

const worker = (id = "w1", capabilities: string[] = []) =>
  new FakeWorker(api.url, id, capabilities);
const enqueue = (
  key: string,
  extra: Partial<Parameters<typeof enqueueJob>[1]> = {},
) => enqueueJob(db.pool, { type: "agent-run", idempotencyKey: key, ...extra });

describe("claiming", () => {
  it("hands out nothing when the queue is empty", async () => {
    const reply = await worker().claim();
    expect(reply).toEqual({ status: 200, body: { job: null } });
  });

  it("hands a queued job to a worker with a two-minute lease", async () => {
    const { job } = await enqueue("T-1:1:implement:1", {
      payload: { stage: "implement" },
    });
    const reply = await worker().claim();
    expect(reply.status).toBe(200);
    expect(reply.body.job).toMatchObject({
      id: job.id,
      type: "agent-run",
      payload: { stage: "implement" },
      attempt: 1,
      leaseExpiresAt: "2026-01-01T00:02:00.000Z",
    });
  });

  it("does not hand the same job to a second worker", async () => {
    await enqueue("a");
    expect((await worker("w1").claim()).body.job).not.toBeNull();
    expect((await worker("w2").claim()).body.job).toBeNull();
  });
});

describe("working a claimed job", () => {
  async function claimed(key = "a") {
    await enqueue(key);
    const holder = worker("w1");
    const job = (await holder.claim()).body.job as NonNullable<
      Awaited<ReturnType<typeof holder.claim>>["body"]["job"]
    >;
    return { holder, job };
  }

  it("a heartbeat pushes the lease two minutes past the moment it arrives", async () => {
    const { holder, job } = await claimed();
    clock.advanceSeconds(30);
    const reply = await holder.heartbeat(job.id, job.attempt);
    expect(reply).toEqual({
      status: 200,
      body: { leaseExpiresAt: "2026-01-01T00:02:30.000Z" },
    });
  });

  it("checking before a push renews the lease from the moment it arrives", async () => {
    const { holder, job } = await claimed();
    clock.advanceSeconds(100);
    const reply = await holder.prePush(job.id, job.attempt);
    expect(reply).toEqual({
      status: 200,
      body: { ok: true, leaseExpiresAt: "2026-01-01T00:03:40.000Z" },
    });
    clock.advanceSeconds(100); // 200 s after the claim: past the original lease, inside the renewed one
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it("completing stores the result and the job is not handed out again", async () => {
    const { holder, job } = await claimed("done-key");
    expect(
      (await holder.complete(job.id, job.attempt, { commits: ["abc"] })).status,
    ).toBe(200);
    const seen = (await enqueue("done-key")).job;
    expect(seen).toMatchObject({ state: "done", result: { commits: ["abc"] } });
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it("failing records the error and the job is not handed out again", async () => {
    const { holder, job } = await claimed("fail-key");
    expect((await holder.fail(job.id, job.attempt, "gate failed")).status).toBe(
      200,
    );
    expect((await enqueue("fail-key")).job).toMatchObject({
      state: "failed",
      error: "gate failed",
    });
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it.each(["heartbeat", "prePush", "complete", "fail"] as const)(
    "%s from a stale attempt is refused",
    async (call) => {
      const { holder, job } = await claimed();
      expect((await holder[call](job.id, job.attempt + 1)).status).toBe(409);
    },
  );

  it.each(["heartbeat", "prePush", "complete", "fail"] as const)(
    "%s from a worker that does not hold the lease is refused",
    async (call) => {
      const { job } = await claimed();
      expect((await worker("intruder")[call](job.id, job.attempt)).status).toBe(
        409,
      );
    },
  );

  it("nothing is accepted once the job is finished", async () => {
    const { holder, job } = await claimed();
    await holder.complete(job.id, job.attempt);
    expect((await holder.complete(job.id, job.attempt)).status).toBe(409);
    expect((await holder.heartbeat(job.id, job.attempt)).status).toBe(409);
  });

  it("an unknown job is a 404, not a server error", async () => {
    expect((await worker().heartbeat(99999, 1)).status).toBe(404);
  });
});

describe("leases that run out", () => {
  it("goes back to the queue with the attempt bumped, and the old holder is shut out", async () => {
    await enqueue("a");
    const first = worker("w1");
    const job = (await first.claim()).body.job as ClaimedJob;
    clock.advanceSeconds(121);

    const second = worker("w2");
    const retaken = (await second.claim()).body.job;
    expect(retaken).toMatchObject({ id: job.id, attempt: job.attempt + 1 });

    expect((await first.heartbeat(job.id, job.attempt)).status).toBe(409);
    expect((await first.complete(job.id, job.attempt)).status).toBe(409);
    expect((await first.prePush(job.id, job.attempt)).status).toBe(409);
    expect((await second.complete(job.id, job.attempt + 1)).status).toBe(200);
  });

  it("a holder that missed its deadline cannot complete even if nobody took the job yet", async () => {
    await enqueue("a");
    const holder = worker();
    const job = (await holder.claim()).body.job as ClaimedJob;
    clock.advanceSeconds(121);
    expect((await holder.complete(job.id, job.attempt)).status).toBe(409);
  });

  it("is not taken back while heartbeats keep arriving every 30 seconds", async () => {
    await enqueue("a");
    const holder = worker();
    const job = (await holder.claim()).body.job as ClaimedJob;
    for (let beat = 0; beat < 8; beat++) {
      clock.advanceSeconds(30);
      expect((await holder.heartbeat(job.id, job.attempt)).status).toBe(200);
    }
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it("each further expiry bumps the attempt again", async () => {
    await enqueue("a");
    let attempt = 0;
    for (let round = 0; round < 3; round++) {
      const job = (await worker(`w${round}`).claim()).body.job as ClaimedJob;
      expect(job.attempt).toBe(attempt + 1);
      attempt = job.attempt;
      clock.advanceSeconds(121);
    }
  });
});

describe("idempotency keys", () => {
  it("submitting the same key again returns the job that already exists", async () => {
    const first = await enqueue("T-1:1:implement:1", { payload: { n: 1 } });
    const again = await enqueue("T-1:1:implement:1", { payload: { n: 2 } });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.payload).toEqual({ n: 1 });
  });

  it("does not make a second job to claim", async () => {
    await enqueue("a");
    await enqueue("a");
    expect((await worker("w1").claim()).body.job).not.toBeNull();
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it("hands back the finished result when the work was already done", async () => {
    await enqueue("a");
    const holder = worker();
    const job = (await holder.claim()).body.job as ClaimedJob;
    await holder.complete(job.id, job.attempt, { commits: ["abc"] });
    const again = await enqueue("a");
    expect(again.created).toBe(false);
    expect(again.job).toMatchObject({
      state: "done",
      result: { commits: ["abc"] },
    });
  });

  it("different keys are different jobs", async () => {
    const a = await enqueue("a");
    const b = await enqueue("b");
    expect(a.job.id).not.toBe(b.job.id);
  });
});

describe("capability tags", () => {
  it("a worker without the capability does not get the job", async () => {
    await enqueue("a", { requiredCapabilities: ["docker"] });
    expect((await worker("w1", []).claim()).body.job).toBeNull();
    expect((await worker("w1", ["repo:other"]).claim()).body.job).toBeNull();
  });

  it("a worker with the capability does", async () => {
    await enqueue("a", { requiredCapabilities: ["docker"] });
    expect(
      (await worker("w1", ["docker", "repo:x"]).claim()).body.job,
    ).not.toBeNull();
  });

  it("every required capability is needed, not just one", async () => {
    await enqueue("a", { requiredCapabilities: ["docker", "repo:x"] });
    expect((await worker("w1", ["docker"]).claim()).body.job).toBeNull();
    expect(
      (await worker("w2", ["docker", "repo:x"]).claim()).body.job,
    ).not.toBeNull();
  });

  it("a job that needs nothing can be taken by any worker", async () => {
    await enqueue("a");
    expect((await worker("w1", []).claim()).body.job).not.toBeNull();
  });

  it("skips jobs it cannot do and takes the next one it can", async () => {
    const needsDocker = await enqueue("a", {
      requiredCapabilities: ["docker"],
    });
    const plain = await enqueue("b");
    const got = (await worker("w1", []).claim()).body.job;
    expect(got?.id).toBe(plain.job.id);
    expect((await worker("w2", ["docker"]).claim()).body.job?.id).toBe(
      needsDocker.job.id,
    );
  });
});

describe("lock keys", () => {
  const KEY = "integration:repo-1:spec/order-notes";

  it("a second job with the same key waits while the first holds a live lease", async () => {
    await enqueue("a", { lockKey: KEY });
    await enqueue("b", { lockKey: KEY });
    const first = (await worker("w1").claim()).body.job;
    expect(first).not.toBeNull();
    expect((await worker("w2").claim()).body.job).toBeNull();
  });

  it("is released when the holder finishes, and then the next in line gets it", async () => {
    const a = await enqueue("a", { lockKey: KEY });
    const b = await enqueue("b", { lockKey: KEY });
    const holder = worker("w1");
    const job = (await holder.claim()).body.job as ClaimedJob;
    expect(job.id).toBe(a.job.id);
    await holder.complete(job.id, job.attempt);
    expect((await worker("w2").claim()).body.job?.id).toBe(b.job.id);
  });

  it("is released when the holder fails, too", async () => {
    await enqueue("a", { lockKey: KEY });
    const b = await enqueue("b", { lockKey: KEY });
    const holder = worker("w1");
    const job = (await holder.claim()).body.job as ClaimedJob;
    await holder.fail(job.id, job.attempt);
    expect((await worker("w2").claim()).body.job?.id).toBe(b.job.id);
  });

  it("is released when the lease runs out, but the older job is retried first", async () => {
    const a = await enqueue("a", { lockKey: KEY });
    await enqueue("b", { lockKey: KEY });
    const lost = (await worker("w1").claim()).body.job as ClaimedJob;
    expect((await worker("w2").claim()).body.job).toBeNull();
    clock.advanceSeconds(121);
    const next = (await worker("w2").claim()).body.job;
    expect(next).toMatchObject({ id: a.job.id, attempt: lost.attempt + 1 });
    expect((await worker("w3").claim()).body.job).toBeNull();
  });

  it("serves jobs with the same key strictly first in, first out", async () => {
    const ids = [];
    for (const key of ["a", "b", "c"])
      ids.push((await enqueue(key, { lockKey: KEY })).job.id);
    const seen: number[] = [];
    for (let round = 0; round < 3; round++) {
      const holder = worker(`w${round}`);
      const job = (await holder.claim()).body.job as ClaimedJob;
      seen.push(job.id);
      await holder.complete(job.id, job.attempt);
    }
    expect(seen).toEqual(ids);
  });

  it("a later job does not jump ahead of an earlier one the worker cannot do", async () => {
    await enqueue("a", { lockKey: KEY, requiredCapabilities: ["docker"] });
    await enqueue("b", { lockKey: KEY });
    expect((await worker("plain", []).claim()).body.job).toBeNull();
  });

  it("different keys, and jobs without a key, do not hold each other up", async () => {
    await enqueue("a", { lockKey: "integration:r:spec/a" });
    await enqueue("b", { lockKey: "integration:r:spec/b" });
    await enqueue("c");
    const claimed = [];
    for (const id of ["w1", "w2", "w3"])
      claimed.push((await worker(id).claim()).body.job);
    expect(claimed.every((job) => job !== null)).toBe(true);
  });
});

describe("claiming at the same moment", () => {
  const claimAll = (count: number) =>
    Promise.all(
      Array.from({ length: count }, (_, n) => worker(`w${n}`).claim()),
    ).then((replies) => replies.map((reply) => reply.body.job));

  it("gives every job to exactly one of many racing workers", async () => {
    for (let n = 0; n < 20; n++) await enqueue(`job-${n}`);
    const got = await claimAll(40);
    const handedOut = got.filter((job) => job !== null);
    expect(handedOut).toHaveLength(20);
    expect(new Set(handedOut.map((job) => job.id)).size).toBe(20);
  });

  it("lets only one of several racing workers take a job per lock key", async () => {
    for (const key of ["x", "y", "z"]) {
      for (let n = 0; n < 4; n++)
        await enqueue(`${key}-${n}`, { lockKey: `integration:r:spec/${key}` });
    }
    const got = (await claimAll(24)).filter((job) => job !== null);
    expect(got).toHaveLength(3);
    expect(new Set(got.map((job) => job.lockKey)).size).toBe(3);
  });

  it("racing workers with different capabilities each get only what they can do", async () => {
    for (let n = 0; n < 6; n++) {
      await enqueue(`d-${n}`, {
        requiredCapabilities: ["docker"],
        payload: { needs: "docker" },
      });
    }
    for (let n = 0; n < 6; n++)
      await enqueue(`p-${n}`, { payload: { needs: "nothing" } });
    const replies = await Promise.all([
      ...Array.from({ length: 12 }, (_, n) => worker(`plain-${n}`, []).claim()),
      ...Array.from({ length: 12 }, (_, n) =>
        worker(`dock-${n}`, ["docker"]).claim(),
      ),
    ]);
    const plainGot = replies
      .slice(0, 12)
      .flatMap((reply) => (reply.body.job ? [reply.body.job] : []));
    expect(
      plainGot.every(
        (job) => (job.payload as { needs: string }).needs === "nothing",
      ),
    ).toBe(true);
    const all = replies.flatMap((reply) =>
      reply.body.job ? [reply.body.job] : [],
    );
    expect(all).toHaveLength(12);
    expect(new Set(all.map((job) => job.id)).size).toBe(12);
  });
});

describe("bad input", () => {
  it("numbers that do not fit the database are a 400, not a server error", async () => {
    const w = worker();
    expect((await w.heartbeat(1, 2 ** 40)).status).toBe(400);
    expect((await w.heartbeat(2 ** 40, 1)).status).toBe(400);
    expect((await w.heartbeat(1, -1)).status).toBe(400);
    expect((await w.heartbeat(0, 1)).status).toBe(400);
  });
});

describe("a lease that ran out while workers race for the key", () => {
  it("is retaken by exactly one worker and the key stays exclusive", async () => {
    const KEY = "integration:repo-1:spec/x";
    const older = await enqueue("a", { lockKey: KEY });
    await enqueue("b", { lockKey: KEY });
    await worker("lost").claim();
    clock.advanceSeconds(121);
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, n) => worker(`w${n}`).claim()),
    );
    const got = replies.flatMap((reply) =>
      reply.body.job ? [reply.body.job] : [],
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: older.job.id, attempt: 2 });
  });
});
