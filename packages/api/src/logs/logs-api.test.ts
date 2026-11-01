import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";
import { LogStore } from "./log-store.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;
let logDir: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  logDir = await mkdtemp(join(tmpdir(), "afk-logs-"));
  api = await listen(createApp({ pool: db.pool, clock: clock.now, logDir }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
  await rm(logDir, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { id: number },
  };
}

interface Slice {
  attempt: number;
  offset: number;
  nextOffset: number;
  size: number;
  text: string;
  finished: boolean;
  error?: string;
}
async function readLog(runId: number, query = "") {
  const response = await fetch(`${api.url}/runs/${runId}/logs${query}`);
  return { status: response.status, body: (await response.json()) as Slice };
}
async function appendLog(
  runId: number,
  workerId: string,
  attempt: number,
  chunk: string,
) {
  const reply = await post(`/worker/runs/${runId}/logs`, {
    workerId,
    attempt,
    chunk,
  });
  return {
    status: reply.status,
    body: reply.body as unknown as { size: number; error?: string },
  };
}

// A running spec with one ticket; claiming its implement job starts the Run.
async function claimedRun(worker: FakeWorker) {
  const project = await post("/projects", { name: "shop" });
  await post(`/projects/${project.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await post("/specs", {
    projectId: project.body.id,
    type: "feature",
    slug: "s",
    title: "S",
  });
  await post(
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, {
      tickets: [
        {
          key: "a",
          repo: "backend",
          type: "implementation",
          title: "A",
          modules: ["src/**"],
          acceptance: ["ok"],
        },
      ],
    }),
  );
  await post(`/specs/${spec.body.id}/confirm`);
  const job = (await worker.claim()).body.job;
  if (!job) throw new Error("no job");
  const run = await db.pool.query("SELECT id FROM runs WHERE job_id = $1", [
    job.id,
  ]);
  return { job, runId: run.rows[0].id as number };
}

describe("a run starts when its job is claimed", () => {
  it("is there with a start time and no end, and is finished by the stage result", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { job, runId } = await claimedRun(worker);
    const started = await db.pool.query(
      "SELECT stage, attempt, started_at, finished_at, result FROM runs WHERE id = $1",
      [runId],
    );
    expect(started.rows[0]).toMatchObject({
      stage: "implement",
      attempt: 1,
      finished_at: null,
      result: null,
    });
    expect(started.rows[0].started_at).not.toBeNull();
    expect((await readLog(runId)).body.finished).toBe(false);

    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "done",
    });
    const finished = await db.pool.query(
      "SELECT finished_at, result FROM runs WHERE id = $1",
      [runId],
    );
    expect(finished.rows[0].result).toBe("done");
    expect(finished.rows[0].finished_at).not.toBeNull();
    expect((await readLog(runId)).body.finished).toBe(true);
    expect(
      Number((await db.pool.query("SELECT count(*) FROM runs")).rows[0].count),
    ).toBe(1);
  });
});

describe("appending and reading", () => {
  it("appends chunks to one file per run and reads them back, continuing from an offset", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    expect((await appendLog(runId, "w1", 1, "first line\n")).body.size).toBe(
      11,
    );
    expect((await appendLog(runId, "w1", 1, "second line\n")).body.size).toBe(
      23,
    );

    const all = await readLog(runId);
    expect(all.body).toEqual({
      attempt: 1,
      offset: 0,
      nextOffset: 23,
      size: 23,
      text: "first line\nsecond line\n",
      finished: false,
    });

    const rest = await readLog(runId, "?offset=11");
    expect(rest.body).toMatchObject({
      offset: 11,
      nextOffset: 23,
      text: "second line\n",
    });

    // a poller that is caught up gets nothing, and the same offset back
    expect((await readLog(runId, "?offset=23")).body).toMatchObject({
      text: "",
      nextOffset: 23,
      size: 23,
    });
    await appendLog(runId, "w1", 1, "third\n");
    expect((await readLog(runId, "?offset=23")).body.text).toBe("third\n");
  });

  it("stores the log under the configured directory, one file per run", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    await appendLog(runId, "w1", 1, "hello");
    expect(
      await readFile(join(logDir, `run-${runId}`, "attempt-1.log"), "utf8"),
    ).toBe("hello");
  });

  it("pages with limit and never cuts a character in half", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    const original = "héllo 世界 ✓ 日本語\n";
    await appendLog(runId, "w1", 1, original);
    let offset = 0;
    let text = "";
    for (let i = 0; i < 50; i++) {
      const { body } = await readLog(runId, `?offset=${offset}&limit=4`);
      expect(body.text).not.toContain("�");
      text += body.text;
      if (body.nextOffset >= body.size) break;
      offset = body.nextOffset;
    }
    expect(text).toBe(original);
  });

  it("reads an empty log for a run that has written nothing yet", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    expect((await readLog(runId)).body).toMatchObject({
      attempt: 1,
      text: "",
      size: 0,
      nextOffset: 0,
    });
  });

  it("answers 404 for a run that does not exist", async () => {
    expect((await readLog(999)).status).toBe(404);
    expect((await appendLog(999, "w1", 1, "x")).status).toBe(404);
  });

  it("rejects values the database or the format cannot take", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    expect((await readLog(runId, "?offset=-1")).status).toBe(400);
    expect((await readLog(runId, "?limit=0")).status).toBe(400);
    expect((await readLog(99999999999)).status).toBe(400);
    expect(
      (await appendLog(runId, "w1", 1, "x".repeat(1024 * 1024 + 1))).status,
    ).toBe(400);
  });
});

describe("fencing", () => {
  it("refuses a worker that is not the holder and an attempt that is not the current one", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { runId } = await claimedRun(worker);
    expect((await appendLog(runId, "intruder", 1, "x")).status).toBe(409);
    expect((await appendLog(runId, "w1", 2, "x")).status).toBe(409);
    expect((await readLog(runId)).body.size).toBe(0);
  });

  it("refuses appends once the job has finished", async () => {
    const worker = new FakeWorker(api.url, "w1", []);
    const { job, runId } = await claimedRun(worker);
    await appendLog(runId, "w1", 1, "before\n");
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect((await appendLog(runId, "w1", 1, "after\n")).status).toBe(409);
    expect((await readLog(runId)).body.text).toBe("before\n");
  });

  it("gives a re-dispatched job a fresh log and shuts the old holder out", async () => {
    const w1 = new FakeWorker(api.url, "w1", []);
    const { job, runId } = await claimedRun(w1);
    await appendLog(runId, "w1", job.attempt, "old attempt\n");

    clock.advanceSeconds(121); // the lease runs out; another worker takes over
    const w2 = new FakeWorker(api.url, "w2", []);
    const retaken = (await w2.claim()).body.job;
    expect(retaken).toMatchObject({ id: job.id, attempt: 2 });
    // same Run, no second one
    expect(
      Number((await db.pool.query("SELECT count(*) FROM runs")).rows[0].count),
    ).toBe(1);

    expect((await appendLog(runId, "w1", 1, "zombie\n")).status).toBe(409);
    expect((await appendLog(runId, "w2", 2, "new attempt\n")).status).toBe(200);

    // reads default to the newest attempt; the old one can still be asked for
    expect((await readLog(runId)).body).toMatchObject({
      attempt: 2,
      text: "new attempt\n",
    });
    expect((await readLog(runId, "?attempt=1")).body).toMatchObject({
      attempt: 1,
      text: "old attempt\n",
    });
  });
});

describe("the log store", () => {
  it("does not hand out half a character that is still being written at the end of the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-store-"));
    try {
      const store = new LogStore(dir);
      await store.append(1, 1, "ab");
      // the first two bytes of "世" (e4 b8 96), as a partial write would leave them
      await appendFile(
        join(dir, "run-1", "attempt-1.log"),
        Buffer.from([0xe4, 0xb8]),
      );
      const early = await store.read(1, 1, 0, 100);
      expect(early).toMatchObject({ text: "ab", nextOffset: 2 });
      await appendFile(
        join(dir, "run-1", "attempt-1.log"),
        Buffer.from([0x96]),
      );
      expect((await store.read(1, 1, early.nextOffset, 100)).text).toBe("世");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the size limit under concurrent appends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-store-"));
    try {
      const store = new LogStore(dir, 10);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.append(1, 1, "1234")),
      );
      expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
      expect(await store.size(1, 1)).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an append that would take a run attempt past its size limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-store-"));
    try {
      const store = new LogStore(dir, 10);
      expect(await store.append(1, 1, "123456")).toEqual({
        status: "ok",
        size: 6,
      });
      expect(await store.append(1, 1, "7890")).toEqual({
        status: "ok",
        size: 10,
      });
      expect(await store.append(1, 1, "x")).toEqual({
        status: "too-large",
        size: 10,
      });
      // another attempt has its own budget
      expect(await store.append(1, 2, "x")).toEqual({ status: "ok", size: 1 });
      expect(await store.latestAttempt(1)).toBe(2);
      expect(await store.latestAttempt(2)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
