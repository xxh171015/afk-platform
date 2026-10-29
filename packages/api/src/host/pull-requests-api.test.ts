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

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  api = await listen(createApp({ pool: db.pool, clock: clock.now }));
  worker = new FakeWorker(api.url, "w1", ["host"]);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const ticket = (key: string, repo: string) => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
});

// A spec whose tickets are all done and whose repos' overall reviews have all passed: it is time for pull requests.
async function settledSpec(repos: string[], holdRepoId?: number) {
  let held: { id: number; attempt: number } | undefined;
  const project = await call("POST", "/projects", { name: "shop" });
  for (const role of repos)
    await call("POST", `/projects/${project.body.id}/repos`, {
      url: `https://github.com/me/shop-${role}.git`,
      role,
    });
  const spec = await call("POST", "/specs", {
    projectId: project.body.id,
    type: "feature",
    slug: "export",
    title: "Export orders",
  });
  await call("POST", `/specs/${spec.body.id}/tickets/import`, {
    tickets: repos.map((role) => ticket(role, role)),
  });
  await call("POST", `/specs/${spec.body.id}/confirm`);
  const stages: Record<string, Record<string, unknown>> = {
    implement: { outcome: "done" },
    gate: { outcome: "passed" },
    review: { outcome: "pass" },
    merge: { outcome: "merged", headSha: "head" },
    "final-review": {
      outcome: "pass",
      run: { output: { verdict: "pass", mustFix: [], suggestions: [] } },
    },
  };
  for (let i = 0; i < 60; i++) {
    // a pull request job is the end of this: leave it queued for the test
    const waiting = await db.pool.query(
      "SELECT 1 FROM jobs WHERE type = 'open-pr'",
    );
    if (waiting.rowCount) break;
    const claimed = (await worker.claim()).body.job as {
      id: number;
      attempt: number;
      payload: Json;
    } | null;
    if (!claimed) break;
    if (
      claimed.payload.stage === "final-review" &&
      claimed.payload.repoId === holdRepoId
    ) {
      held = claimed;
      continue;
    }
    await worker.complete(claimed.id, claimed.attempt, {
      stage: claimed.payload.stage,
      ...stages[claimed.payload.stage],
    });
  }
  return { specId: spec.body.id as number, held };
}

const specState = async () =>
  (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;
const pulls = async () =>
  (
    await db.pool.query(
      "SELECT repo_id, number, url, state, ci, review FROM pull_requests ORDER BY repo_id",
    )
  ).rows as Json[];
const jobsOf = async (type: string) =>
  (
    await db.pool.query(
      "SELECT state, lock_key, payload, idempotency_key FROM jobs WHERE type = $1 ORDER BY id",
      [type],
    )
  ).rows as Json[];

async function claimOf(type: string) {
  const job = (await worker.claim()).body.job;
  expect(job?.type).toBe(type);
  return job as { id: number; attempt: number; payload: Json };
}
const taskOf = async (job: { id: number; attempt: number }, attempt?: number) =>
  fetch(
    `${api.url}/worker/jobs/${job.id}/host-task?workerId=w1&attempt=${attempt ?? job.attempt}`,
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as Json }));

const opened = (number: number, extra: Record<string, unknown> = {}) => ({
  stage: "open-pr",
  outcome: "opened",
  number,
  url: `https://github.com/me/shop/pull/${number}`,
  state: "open",
  draft: false,
  headSha: `sha${number}`,
  ci: "none",
  review: "none",
  ...extra,
});
const synced = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  state: "open",
  draft: false,
  headSha: "sha",
  ci: "pending",
  review: "none",
  ...extra,
});

describe("opening the pull requests", () => {
  it("queues an open-pr job, without a lock key, when the last repo is settled", async () => {
    await settledSpec(["backend"]);
    expect(await jobsOf("open-pr")).toMatchObject([
      {
        state: "queued",
        lock_key: null,
        payload: { specId: 1, repoId: 1 },
        idempotency_key: "S-1:repo-1:open-pr:1",
      },
    ]);
    expect(await specState()).toBe("finalizing");
  });

  it("waits until every repo of the spec is settled", async () => {
    const { held } = await settledSpec(["backend", "frontend"], 2);
    expect(await jobsOf("open-pr")).toEqual([]); // the frontend's review is still out
    expect(await specState()).toBe("finalizing");
    const review = held as { id: number; attempt: number };
    await worker.complete(review.id, review.attempt, {
      stage: "final-review",
      outcome: "pass",
    });
    expect(
      (await jobsOf("open-pr")).map((j: Json) => j.payload.repoId),
    ).toEqual([1, 2]);
  });

  it("tells the worker what to open: branch, base, title, and a description with the spec and its tickets", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    const task = await taskOf(job);
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({
      kind: "open-pr",
      repoUrl: "https://github.com/me/shop-backend.git",
      base: "main",
      head: "spec/export",
      title: "S-1 Export orders",
      draft: false,
    });
    expect(task.body.body).toContain("Spec: S-1");
    expect(task.body.body).toContain("- T-1 Ticket backend");
  });

  it("only gives the task to the job's current holder", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    expect((await taskOf(job, job.attempt + 1)).status).toBe(409);
  });

  it("records the pull request, moves the spec to awaiting-review and starts following it", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    expect((await worker.complete(job.id, job.attempt, opened(7))).status).toBe(
      200,
    );
    expect(await pulls()).toEqual([
      {
        repo_id: 1,
        number: 7,
        url: "https://github.com/me/shop/pull/7",
        state: "open",
        ci: "none",
        review: "none",
      },
    ]);
    expect(await specState()).toBe("awaiting-review");
    expect(await jobsOf("host-sync")).toMatchObject([
      { state: "queued", lock_key: null, payload: { projectId: 1 } },
    ]);
  });

  it("is merged straight away when the pull request found was already merged", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(7, { state: "merged" }));
    expect(await specState()).toBe("merged");
  });

  it("keeps the spec in finalizing until every repo has its pull request", async () => {
    await settledSpec(["backend", "frontend"]);
    const first = await claimOf("open-pr");
    await worker.complete(first.id, first.attempt, opened(1));
    expect(await specState()).toBe("finalizing");
    const second = await claimOf("open-pr");
    await worker.complete(second.id, second.attempt, opened(2));
    expect(await specState()).toBe("awaiting-review");
  });

  it("ignores the result for a spec that is no longer finalizing", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    await db.pool.query("UPDATE specs SET state = 'cancelled'");
    await worker.complete(job.id, job.attempt, opened(7));
    expect(await pulls()).toEqual([]);
    expect(await specState()).toBe("cancelled");
  });

  it("blocks the finalization when the result is not what a pull request looks like", async () => {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, { stage: "open-pr" });
    expect(
      (await db.pool.query("SELECT state, blocked_reason FROM finalizations"))
        .rows,
    ).toEqual([{ state: "blocked", blocked_reason: "invalid-output" }]);
  });
});

describe("when the pull request cannot be opened", () => {
  it("is tried again, and after three failures blocks the finalization", async () => {
    await settledSpec(["backend"]);
    for (let i = 1; i <= 3; i++) {
      const job = await claimOf("open-pr");
      await worker.fail(job.id, job.attempt, "GitHub answered 503");
      const state = (
        await db.pool.query("SELECT state, blocked_reason FROM finalizations")
      ).rows[0];
      expect(state).toEqual(
        i < 3
          ? { state: "done", blocked_reason: null }
          : { state: "blocked", blocked_reason: "job-failed" },
      );
    }
    expect(await specState()).toBe("finalizing");
    expect((await call("GET", "/blocked")).body.finalizations).toHaveLength(1);
  });

  it("is opened again by a person's retry, which does not repeat the review or the merge", async () => {
    await settledSpec(["backend"]);
    for (let i = 0; i < 3; i++) {
      const job = await claimOf("open-pr");
      await worker.fail(job.id, job.attempt, "GitHub answered 503");
    }
    const retried = await call("POST", "/specs/1/final/retry");
    expect(retried.status).toBe(200);
    expect(retried.body.retried).toEqual(["open-pr"]);
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(3));
    expect(await specState()).toBe("awaiting-review");
    expect(
      (await db.pool.query("SELECT state FROM finalizations")).rows,
    ).toEqual([{ state: "done" }]);
  });
});

describe("following the pull requests", () => {
  async function awaitingReview(repos: string[] = ["backend"]) {
    await settledSpec(repos);
    for (let n = 1; n <= repos.length; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
  }

  it("hands the worker the open pull requests of the project", async () => {
    await awaitingReview(["backend", "frontend"]);
    const task = await taskOf(await claimOf("host-sync"));
    expect(task.body).toEqual({
      kind: "host-sync",
      pulls: [
        { id: 1, repoUrl: "https://github.com/me/shop-backend.git", number: 1 },
        {
          id: 2,
          repoUrl: "https://github.com/me/shop-frontend.git",
          number: 2,
        },
      ],
    });
  });

  it("stores CI and review, and looks again a minute later, not sooner", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { ci: "success", review: "approved" })],
    });
    expect(await pulls()).toMatchObject([
      { ci: "success", review: "approved" },
    ]);
    expect(await specState()).toBe("awaiting-review");

    expect((await worker.claim()).body.job).toBeNull();
    clock.advanceSeconds(59);
    expect((await worker.claim()).body.job).toBeNull();
    clock.advanceSeconds(1);
    expect((await worker.claim()).body.job?.type).toBe("host-sync");
  });

  it("marks the spec merged when a person has merged every pull request, and stops looking", async () => {
    await awaitingReview(["backend", "frontend"]);
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" }), synced(2)],
    });
    expect(await specState()).toBe("awaiting-review"); // one is still open
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(2, { state: "merged" })],
    });
    expect(await specState()).toBe("merged");
    clock.advanceSeconds(600);
    expect((await worker.claim()).body.job).toBeNull();
  });

  it("does not call a closed pull request merged", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "closed" })],
    });
    expect(await specState()).toBe("awaiting-review");
    expect(await pulls()).toMatchObject([{ state: "closed" }]);
  });

  it("skips a pull request the host could not answer for, and keeps the rest", async () => {
    await awaitingReview(["backend", "frontend"]);
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [
        { id: 1, error: "GitHub answered 502" },
        synced(2, { ci: "failure" }),
      ],
    });
    expect(await pulls()).toMatchObject([{ ci: "none" }, { ci: "failure" }]);
  });

  it("keeps the reason a pull request could not be read, until a look works again", async () => {
    await awaitingReview();
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [{ id: 1, error: "GitHub answered 404" }],
    });
    const error = async () =>
      (await db.pool.query("SELECT sync_error FROM pull_requests")).rows[0]
        .sync_error;
    expect(await error()).toBe("GitHub answered 404");
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(1)],
    });
    expect(await error()).toBeNull();
  });

  it("looks again in a minute when a look failed", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.fail(job.id, job.attempt, "GitHub is down");
    expect((await worker.claim()).body.job).toBeNull();
    clock.advanceSeconds(60);
    expect((await worker.claim()).body.job?.type).toBe("host-sync");
  });

  it("keeps one chain of looks per project", async () => {
    await awaitingReview(["backend", "frontend"]);
    expect(await jobsOf("host-sync")).toHaveLength(1);
  });
});
