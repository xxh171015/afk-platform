import { type Io, run } from "@afk/cli";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAcceptancePack } from "../acceptance/pack.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import type { Notice } from "../notify/notices.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;
let notices: Notice[];

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  clock = new FakeClock();
  notices = [];
  api = await listen(
    testApp({
      pool: db.pool,
      clock: clock.now,
      notifications: {
        async notify(notice) {
          notices.push(notice);
        },
      },
    }),
  );
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
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const ticket = (
  key: string,
  repo: string,
  acceptance: string[] = [`${key} works`],
  extra: Record<string, unknown> = {},
) => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance,
  ...extra,
});

// A spec whose tickets are all done and whose repos' overall reviews have all passed: it is time for pull requests.
type StageResults = Record<
  string,
  Record<string, unknown> | Record<string, unknown>[]
>;
async function settledSpec(
  repos: string[],
  holdRepoId?: number,
  options: {
    tickets?: Record<string, unknown>[];
    stages?: StageResults;
    contractPaths?: Record<string, string>; // repo name -> its contract path
  } = {},
) {
  let held: { id: number; attempt: number } | undefined;
  const project = await call("POST", "/projects", { name: "shop" });
  for (const role of repos)
    await call("POST", `/projects/${project.body.id}/repos`, {
      url: `https://github.com/me/shop-${role}.git`,
      role,
    });
  for (const [name, contractPath] of Object.entries(
    options.contractPaths ?? {},
  ).filter(([name]) => repos.includes(name))) {
    const response = await fetch(
      `${api.url}/projects/${project.body.id}/repos/${name}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contractPath }),
      },
    );
    expect(response.status).toBe(200);
  }
  const spec = await call("POST", "/specs", {
    projectId: project.body.id,
    type: "feature",
    slug: "export",
    title: "Export orders",
  });
  await call(
    "POST",
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, {
      tickets: options.tickets ?? repos.map((role) => ticket(role, role)),
    }),
  );
  await call("POST", `/specs/${spec.body.id}/confirm`);
  const stages: StageResults = {
    implement: { outcome: "done" },
    gate: { outcome: "passed" },
    review: { outcome: "pass" },
    merge: { outcome: "merged", headSha: "head" },
    "final-review": {
      outcome: "pass",
      run: { output: { verdict: "pass", mustFix: [], suggestions: [] } },
    },
  };
  Object.assign(stages, options.stages);
  for (let i = 0; i < 60; i++) {
    // a pull request job is the end of this: leave it queued for the test
    const waiting = await db.pool.query(
      "SELECT 1 FROM jobs WHERE type = 'open-pr'",
    );
    if (waiting.rowCount) break;
    const claimed = (await worker.claim()).body.job as {
      id: number;
      type: string;
      attempt: number;
      payload: Json;
    } | null;
    if (!claimed) break;
    if (claimed.type === "host-sync") {
      await worker.complete(claimed.id, claimed.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    if (
      claimed.payload.stage === "final-review" &&
      claimed.payload.repoId === holdRepoId
    ) {
      held = claimed;
      continue;
    }
    // a list of results is used one by one, the last one for every later job of the stage
    const planned = stages[claimed.payload.stage];
    const result = Array.isArray(planned)
      ? planned.length > 1
        ? planned.shift()
        : planned[0]
      : planned;
    await worker.complete(claimed.id, claimed.attempt, {
      stage: claimed.payload.stage,
      ...result,
    });
  }
  return { specId: spec.body.id as number, held };
}

// Answers the next host-sync with the given facts about pull requests, a minute on.
const PATCHED = { stage: "patch-pr-body", outcome: "patched" };

async function completeIfPatch(job: {
  type: string;
  id: number;
  attempt: number;
}) {
  if (job.type !== "patch-pr-body") return false;
  await worker.complete(job.id, job.attempt, PATCHED);
  return true;
}

// Host-sync created at confirm has a low id, so a later look can land before pack patches.
async function expectNothingDue() {
  for (let i = 0; i < 8; i++) {
    const job = (await worker.claim()).body.job;
    if (!job) return;
    if (await completeIfPatch(job)) continue;
    expect(job).toBeNull();
  }
}

async function syncWith(pulls: Json[]) {
  clock.advanceSeconds(61);
  for (let i = 0; i < 8; i++) {
    const job = (await worker.claim()).body.job;
    if (!job) break;
    if (await completeIfPatch(job)) continue;
    if (job.type === "host-sync") {
      await worker.complete(job.id, job.attempt, { stage: "host-sync", pulls });
      return;
    }
  }
  throw new Error("no host-sync job");
}

const specState = async () =>
  (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;
const pulls = async () =>
  (
    await db.pool.query(
      "SELECT repo_id, number, url, state, ci, review FROM pull_requests ORDER BY repo_id",
    )
  ).rows as Json[];
const instanceId = async () =>
  (await db.pool.query<{ id: string }>("SELECT id FROM instance")).rows[0]?.id;

const jobsOf = async (type: string) =>
  (
    await db.pool.query(
      "SELECT state, lock_key, payload, idempotency_key FROM jobs WHERE type = $1 ORDER BY id",
      [type],
    )
  ).rows as Json[];

async function claimOf(type: string) {
  for (let i = 0; i < 8; i++) {
    const job = (await worker.claim()).body.job;
    if (!job) break;
    if (job.type === type)
      return job as { id: number; attempt: number; payload: Json };
    if (await completeIfPatch(job)) continue;
    if (job.type === "host-sync") {
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
      continue;
    }
    expect(job.type).toBe(type);
  }
  throw new Error(`no ${type} job`);
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

// backend's contract is used by the frontend; payments' contract is used by the backend
const CONTRACT_PATHS = { backend: "openapi.yaml", payments: "pay.yaml" };
const contractTicket = (key: string, repo: string) =>
  ticket(key, repo, undefined, { type: "contract" });

describe("the order pull requests are merged in", () => {
  async function draftsByRepo() {
    const drafts: Record<string, boolean> = {};
    for (const job of await jobsOf("open-pr")) {
      const claimed = await claimOf("open-pr");
      const task = await taskOf(claimed);
      drafts[task.body.repoUrl.match(/shop-(\w+)\.git/)[1]] = task.body.draft;
      await worker.complete(
        claimed.id,
        claimed.attempt,
        opened(job.payload.repoId, { draft: task.body.draft }),
      );
    }
    return drafts;
  }

  it("opens the pull request of the repo that uses another's contract as a draft, and the other not", async () => {
    await settledSpec(["backend", "frontend"], undefined, {
      contractPaths: CONTRACT_PATHS,
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", undefined, { contract: "contract" }),
      ],
    });
    expect(await draftsByRepo()).toEqual({ backend: false, frontend: true });
  });

  it("opens no draft when the repos have no contract relation", async () => {
    await settledSpec(["backend", "frontend"]);
    expect(await draftsByRepo()).toEqual({ backend: false, frontend: false });
  });

  it("orders three repos along two relations: payments, then backend, then frontend", async () => {
    await settledSpec(["backend", "frontend", "payments"], undefined, {
      contractPaths: CONTRACT_PATHS,
      tickets: [
        contractTicket("cp", "payments"),
        contractTicket("cb", "backend"),
        ticket("be", "backend", undefined, { contract: "cp" }),
        ticket("fe", "frontend", undefined, { contract: "cb" }),
      ],
    });
    expect(await draftsByRepo()).toEqual({
      backend: true,
      frontend: true,
      payments: false,
    });
    const view = (await call("GET", "/specs/1")).body;
    expect(view.mergeOrder).toEqual({
      ordered: ["payments", "backend", "frontend"],
      after: { payments: [], backend: ["payments"], frontend: ["backend"] },
      unordered: [],
    });
    expect(view.pullRequests.map((p: Json) => [p.repo, p.draft])).toEqual(
      expect.arrayContaining([
        ["payments", false],
        ["backend", true],
        ["frontend", true],
      ]),
    );
  });
});

describe("turning a draft pull request ready", () => {
  // backend's pull request is #1 (not a draft); the frontend's, which uses its contract, is #2 and a draft
  async function draftSetup() {
    await settledSpec(["backend", "frontend"], undefined, {
      contractPaths: CONTRACT_PATHS,
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", undefined, { contract: "contract" }),
      ],
    });
    for (const [n, draft] of [
      [1, false],
      [2, true],
    ] as const) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n, { draft }));
    }
  }
  // the next job of this type; a host-sync that is due first is answered with nothing to report
  async function claimNamed(type: string) {
    for (let i = 0; i < 8; i++) {
      const job = (await worker.claim()).body.job;
      if (!job) break;
      if (job.type === type)
        return job as { id: number; attempt: number; payload: Json };
      if (await completeIfPatch(job)) continue;
      if (job.type === "host-sync") {
        await worker.complete(job.id, job.attempt, {
          stage: "host-sync",
          pulls: [],
        });
      } else {
        throw new Error(`unexpected ${job.type} job`);
      }
    }
    throw new Error(`no ${type} job`);
  }
  // The next host-sync; a pr-ready job queued before it is left running (a worker that has taken it and not yet
  // finished), which is also what keeps another from being queued.
  async function claimSyncKeeping() {
    for (let i = 0; i < 8; i++) {
      const job = (await worker.claim()).body.job;
      if (!job) break;
      if (await completeIfPatch(job)) continue;
      if (job.type === "host-sync")
        return job as { id: number; attempt: number; payload: Json };
    }
    throw new Error("no host-sync job");
  }
  // answers the next host-sync with the given facts for the two pull requests
  async function sync(facts: Record<number, Record<string, unknown>>) {
    clock.advanceSeconds(61);
    const job = await claimSyncKeeping();
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: Object.entries(facts).map(([id, extra]) =>
        synced(Number(id), extra),
      ),
    });
  }
  const BACKEND_MERGED = { 1: { state: "merged" }, 2: { draft: true } };

  it("queues a pr-ready job for the draft once the pull request it waits for is merged, and not before", async () => {
    await draftSetup();
    await sync({ 1: {}, 2: { draft: true } });
    expect(await jobsOf("pr-ready")).toEqual([]);

    await sync(BACKEND_MERGED);
    expect(await jobsOf("pr-ready")).toMatchObject([
      { state: "queued", lock_key: null, payload: { pullId: 2 } },
    ]);
    // another look while it is still queued adds nothing
    await sync(BACKEND_MERGED);
    expect(await jobsOf("pr-ready")).toHaveLength(1);
  });

  it("tells the worker which pull request to turn ready, and records it as ready when the worker has", async () => {
    await draftSetup();
    await sync(BACKEND_MERGED);
    const job = await claimOf("pr-ready");
    expect((await taskOf(job)).body).toEqual({
      kind: "pr-ready",
      pull: {
        id: 2,
        repoUrl: "https://github.com/me/shop-frontend.git",
        number: 2,
      },
    });
    await worker.complete(job.id, job.attempt, {
      stage: "pr-ready",
      ...synced(2, { draft: false }),
    });
    expect((await pulls()).find((p) => p.number === 2)).toBeTruthy();
    const draft = await db.pool.query(
      "SELECT draft FROM pull_requests WHERE id = 2",
    );
    expect(draft.rows[0].draft).toBe(false);
    expect(
      (await call("GET", "/specs/1")).body.pullRequests.find(
        (p: Json) => p.repo === "frontend",
      ).draft,
    ).toBe(false);
  });

  it("queues nothing when a person has already turned it ready", async () => {
    await draftSetup();
    await sync({ 1: { state: "merged" }, 2: { draft: false } });
    expect(await jobsOf("pr-ready")).toEqual([]);
  });

  it("waits for every pull request a draft is behind", async () => {
    await settledSpec(["backend", "frontend", "payments"], undefined, {
      contractPaths: CONTRACT_PATHS,
      tickets: [
        contractTicket("cp", "payments"),
        contractTicket("cb", "backend"),
        ticket("be", "backend", undefined, { contract: "cp" }),
        ticket("fe", "frontend", undefined, { contract: "cb" }),
      ],
    });
    // repos are numbered backend 1, frontend 2, payments 3; their pull requests are numbered the same way
    for (const [n, draft] of [
      [1, true],
      [2, true],
      [3, false],
    ] as const) {
      const job = await claimOf("open-pr");
      await worker.complete(
        job.id,
        job.attempt,
        opened(job.payload.repoId, { draft }),
      );
      void n;
    }
    await sync({
      3: { state: "merged" },
      1: { draft: true },
      2: { draft: true },
    });
    expect(
      (await jobsOf("pr-ready")).map((j: Json) => j.payload.pullId),
    ).toEqual([1]); // backend is ready to go; the frontend still waits for the backend
    const job = await claimOf("pr-ready");
    await worker.complete(job.id, job.attempt, {
      stage: "pr-ready",
      ...synced(1, { draft: false }),
    });
    await sync({
      3: { state: "merged" },
      1: { state: "merged" },
      2: { draft: true },
    });
    expect(
      (await jobsOf("pr-ready")).map((j: Json) => j.payload.pullId),
    ).toEqual([1, 2]);
  });

  it("tries a failed pr-ready again a minute later, three times in all, and then shows it in plat blocked", async () => {
    await draftSetup();
    await sync(BACKEND_MERGED);
    for (let n = 1; n <= 3; n++) {
      const job = await claimNamed("pr-ready");
      await worker.fail(job.id, job.attempt, "GitHub answered 403");
      if (n < 3) {
        // a minute has to pass before the next try
        expect((await worker.claim()).body.job?.type ?? "nothing").not.toBe(
          "pr-ready",
        );
        clock.advanceSeconds(61);
      }
    }
    expect(await jobsOf("pr-ready")).toHaveLength(3);

    const blocked = (await call("GET", "/blocked")).body;
    expect(blocked.readyFailures).toEqual([
      expect.objectContaining({
        specId: 1,
        repo: "frontend",
        number: 2,
        error: expect.stringMatching(/403/),
      }),
    ]);
    // the next look at the host does not queue it again by itself
    await sync(BACKEND_MERGED);
    expect(await jobsOf("pr-ready")).toHaveLength(3);
  });
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
      head: `spec/${await instanceId()}/export`,
      title: "S-1 Export orders",
      draft: false,
    });
    expect(task.body.body).toContain("Spec: S-1");
    expect(task.body.body).toContain("- T-1 Ticket backend");
    expect(task.body.body).toContain("the platform never merges");
    expect(task.body.body).not.toContain("afk-acceptance-pack");
  });

  it("opens the pull request from the flat branch of a spec that was made before the databases had ids", async () => {
    await settledSpec(["backend"]);
    await db.pool.query("UPDATE specs SET branch_namespace = NULL");
    const job = await claimOf("open-pr");
    expect((await taskOf(job)).body).toMatchObject({ head: "spec/export" });
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
    const settled = await settledSpec(repos);
    for (let n = 1; n <= repos.length; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
    return settled;
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
      defaults: [
        { repoUrl: "https://github.com/me/shop-backend.git", branch: "main" },
        { repoUrl: "https://github.com/me/shop-frontend.git", branch: "main" },
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

    await expectNothingDue();
    clock.advanceSeconds(59);
    await expectNothingDue();
    clock.advanceSeconds(1);
    const next = (await worker.claim()).body.job;
    expect(next).toMatchObject({
      type: "host-sync",
      id: job.id,
      attempt: job.attempt + 1,
    });
  });

  it("marks the spec merged when a person has merged every pull request, and stops looking", async () => {
    await awaitingReview(["backend", "frontend"]);
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" }), synced(2)],
    });
    expect(await specState()).toBe("partially-merged"); // one is merged, one is still open
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(2, { state: "merged" })],
    });
    expect(await specState()).toBe("merged");
    expect(second.id).toBe(first.id);
    expect(await jobsOf("host-sync")).toMatchObject([{ state: "done" }]);
    clock.advanceSeconds(600);
    await claimOf("spec-cleanup"); // the clean-up of the spec; nothing else is looked at
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

  it("goes on looking at a pull request closed without merge, so a reopen or a merge is noticed", async () => {
    await awaitingReview();
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "closed" })],
    });
    expect(await specState()).toBe("awaiting-review");
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    expect((await taskOf(second)).body.pulls).toMatchObject([{ id: 1 }]);
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" })],
    });
    expect(await specState()).toBe("merged");
    clock.advanceSeconds(600);
    await claimOf("spec-cleanup"); // the clean-up of the spec; nothing else is looked at
    expect((await worker.claim()).body.job).toBeNull();
  });

  it("stops looking at the pull requests of a cancelled spec", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await call("POST", "/specs/1/cancel");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1)],
    });
    clock.advanceSeconds(600);
    await claimOf("spec-cleanup"); // the clean-up of the spec; nothing else is looked at
    expect((await worker.claim()).body.job).toBeNull();
  });

  it("refuses to cancel a spec with a pull request merged and another still open", async () => {
    await awaitingReview(["backend", "frontend"]);
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" }), synced(2)],
    });
    expect(await specState()).toBe("partially-merged");
    const refused = await call("POST", "/specs/1/cancel");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/merged.*still open/);
    expect(await specState()).toBe("partially-merged");
  });

  it("goes awaiting-review, then partially-merged, then merged as the pull requests are merged, and cleans up only at the end", async () => {
    await awaitingReview(["backend", "frontend"]);
    expect(await specState()).toBe("awaiting-review");
    await syncWith([synced(1, { state: "merged" }), synced(2)]);
    expect(await specState()).toBe("partially-merged");
    expect(await jobsOf("spec-cleanup")).toEqual([]);
    await syncWith([synced(2, { state: "merged" })]);
    expect(await specState()).toBe("merged");
    expect(await jobsOf("spec-cleanup")).toHaveLength(1);
  });

  it("can be cancelled when it is partially merged and the pull requests that are left have been closed, and keeps what is merged", async () => {
    await awaitingReview(["backend", "frontend"]);
    await syncWith([synced(1, { state: "merged" }), synced(2)]);
    expect((await call("POST", "/specs/1/cancel")).status).toBe(409);
    await syncWith([synced(2, { state: "closed" })]);
    expect(await specState()).toBe("partially-merged");
    const cancelled = await call("POST", "/specs/1/cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe("cancelled");
    expect(await jobsOf("spec-cleanup")).toHaveLength(1);
    const merged = await db.pool.query(
      "SELECT state FROM pull_requests ORDER BY id",
    );
    expect(merged.rows.map((r) => r.state)).toEqual(["merged", "closed"]);
  });

  describe("when a repo is merged before the repos it waits for", () => {
    beforeEach(async () => {
      await settledSpec(["backend", "frontend"], undefined, {
        contractPaths: { backend: "openapi.yaml" },
        tickets: [
          contractTicket("contract", "backend"),
          ticket("fe", "frontend", undefined, { contract: "contract" }),
        ],
      });
      for (const [n, draft] of [
        [1, false],
        [2, true],
      ] as const) {
        const job = await claimOf("open-pr");
        await worker.complete(job.id, job.attempt, opened(n, { draft }));
      }
    });
    const view = async () => (await call("GET", "/specs/1")).body;

    it("marks the order as broken, and goes on as usual, without a place in plat blocked", async () => {
      expect((await view()).orderBroken).toEqual([]);
      await syncWith([synced(2, { state: "merged" }), synced(1)]);
      expect(await specState()).toBe("partially-merged");
      expect((await view()).orderBroken).toEqual([
        { repo: "frontend", skipped: ["backend"] },
      ]);
      const blocked = (await call("GET", "/blocked")).body;
      expect(blocked.pullRequests).toEqual([]);
      expect(blocked.specs).toEqual([]);
      await syncWith([synced(1, { state: "merged" })]);
      expect(await specState()).toBe("merged");
      // merged in the end, but the frontend went first: the fact stays on the spec
      expect((await view()).orderBroken).toEqual([
        { repo: "frontend", skipped: ["backend"] },
      ]);
    });

    it("is printed by plat spec show", async () => {
      await syncWith([synced(2, { state: "merged" }), synced(1)]);
      let out = "";
      const io: Io = {
        stdout: (text) => {
          out += text;
        },
        stderr: () => {},
        env: { AFK_API_URL: api.url },
        readFile: async () => "",
        readDirectory: async () => [],
      };
      expect(await run(["spec", "show", "S-1"], io)).toBe(0);
      expect(out).toContain(
        "merge order broken: frontend was merged before backend",
      );
    });

    it("keeps the draft when the pull request it waits for was closed without merge, and plat blocked lists the closed one", async () => {
      await syncWith([
        synced(1, { state: "closed" }),
        synced(2, { draft: true }),
      ]);
      expect(await jobsOf("pr-ready")).toEqual([]);
      const blocked = (await call("GET", "/blocked")).body;
      expect(blocked.pullRequests).toMatchObject([
        { repo: "backend", state: "closed" },
      ]);
    });
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
    await expectNothingDue();
    clock.advanceSeconds(60);
    const next = (await worker.claim()).body.job;
    expect(next).toMatchObject({ type: "host-sync", id: job.id });
  });

  it("looks again after Retry-After when GitLab answered 429", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.fail(
      job.id,
      job.attempt,
      "GitLab answered 429; retry after 12s",
    );
    await expectNothingDue();
    clock.advanceSeconds(11);
    await expectNothingDue();
    clock.advanceSeconds(1);
    expect((await worker.claim()).body.job).toMatchObject({
      type: "host-sync",
      id: job.id,
    });
  });

  it("stores the host's merge time and flags a merge by the platform token", async () => {
    const { specId } = await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [
        synced(1, {
          state: "merged",
          mergedBy: "bot",
          mergedAt: "2026-11-09T10:00:00.000Z",
          mergedByPlatform: true,
        }),
      ],
    });
    const pull = (
      await db.pool.query<{ merged_at: Date; merged_by: string }>(
        "SELECT merged_at, merged_by FROM pull_requests",
      )
    ).rows[0];
    expect(pull.merged_by).toBe("bot");
    expect(pull.merged_at.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(
      (await db.pool.query("SELECT token_merged FROM specs")).rows[0]
        .token_merged,
    ).toBe(true);
    expect((await call("GET", `/specs/${specId}`)).body.spec.tokenMerged).toBe(
      true,
    );
  });

  it("does not flag a merge when the token did not merge it", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [
        synced(1, {
          state: "merged",
          mergedBy: "alice",
          mergedAt: "2026-11-09T10:00:00.000Z",
          mergedByPlatform: false,
        }),
      ],
    });
    expect(
      (await db.pool.query("SELECT token_merged FROM specs")).rows[0]
        .token_merged,
    ).toBe(false);
  });

  it("keeps one host-sync job per project, put back in the queue after each look", async () => {
    await awaitingReview(["backend", "frontend"]);
    expect(await jobsOf("host-sync")).toMatchObject([
      {
        state: "queued",
        lock_key: null,
        payload: { projectId: 1 },
        idempotency_key: "project-1:host-sync",
      },
    ]);
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1), synced(2)],
    });
    expect(await jobsOf("host-sync")).toMatchObject([
      {
        state: "queued",
        idempotency_key: "project-1:host-sync",
        payload: { projectId: 1 },
      },
    ]);
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    expect(second.id).toBe(first.id);
  });

  it("takes the same job again when the worker dies and the lease runs out", async () => {
    await awaitingReview();
    const first = await claimOf("host-sync");
    clock.advanceSeconds(121);
    const second = await claimOf("host-sync");
    expect(second).toMatchObject({
      id: first.id,
      attempt: first.attempt + 1,
    });
    expect(
      (
        await worker.complete(first.id, first.attempt, {
          stage: "host-sync",
          pulls: [synced(1)],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await worker.complete(second.id, second.attempt, {
          stage: "host-sync",
          pulls: [synced(1)],
        })
      ).status,
    ).toBe(200);
    expect(await jobsOf("host-sync")).toHaveLength(1);
  });

  it("a complete from the last look cannot land on the next one", async () => {
    await awaitingReview();
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1)],
    });
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    expect(
      (
        await worker.complete(first.id, first.attempt, {
          stage: "host-sync",
          pulls: [synced(1, { ci: "failure" })],
        })
      ).status,
    ).toBe(409);
    expect(await pulls()).toMatchObject([{ ci: "pending" }]);
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { ci: "success" })],
    });
    expect(await pulls()).toMatchObject([{ ci: "success" }]);
  });

  // the events host-sync writes (docs/specs/m3-platform.md「事件表」)
  const hostEvents = async () =>
    (
      await db.pool.query(
        `SELECT type, from_state, to_state, reason, source, failure_source FROM events
         WHERE type LIKE 'pull-request%' AND source = 'host-sync' ORDER BY id`,
      )
    ).rows;
  const eventCount = async () =>
    (await db.pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n;

  it("records what a look found changed, and nothing for a look that found nothing new", async () => {
    await awaitingReview();
    const first = await claimOf("host-sync");
    await worker.complete(first.id, first.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { ci: "success", review: "approved" })],
    });
    expect(await hostEvents()).toEqual([
      expect.objectContaining({
        type: "pull-request-ci",
        from_state: "none",
        to_state: "success",
      }),
      expect.objectContaining({
        type: "pull-request-review",
        from_state: "none",
        to_state: "approved",
      }),
    ]);
    const before = await eventCount();
    clock.advanceSeconds(60);
    const second = await claimOf("host-sync");
    await worker.complete(second.id, second.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { ci: "success", review: "approved" })],
    });
    expect(await eventCount()).toBe(before);
  });

  it("records a pull request that cannot be read as an outside service's failure, once, and when it can again", async () => {
    await awaitingReview();
    for (const pull of [
      { id: 1, error: "GitHub answered 502" },
      { id: 1, error: "GitHub answered 503" },
      synced(1),
    ]) {
      const job = await claimOf("host-sync");
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [pull],
      });
      clock.advanceSeconds(60);
    }
    expect(
      (await hostEvents()).filter((e) => e.type === "pull-request-sync"),
    ).toEqual([
      {
        type: "pull-request-sync",
        from_state: "ok",
        to_state: "error",
        reason: "sync-error",
        source: "host-sync",
        failure_source: "external",
      },
      {
        type: "pull-request-sync",
        from_state: "error",
        to_state: "ok",
        reason: null,
        source: "host-sync",
        failure_source: null,
      },
    ]);
  });

  it("records the merge a look found, and the spec's state change with it", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" })],
    });
    expect(
      (await hostEvents()).filter((e) => e.type === "pull-request"),
    ).toMatchObject([{ from_state: "open", to_state: "merged" }]);
    const spec = await db.pool.query(
      "SELECT from_state, to_state, source FROM events WHERE type = 'spec' ORDER BY id DESC LIMIT 1",
    );
    expect(spec.rows[0]).toEqual({
      from_state: "awaiting-review",
      to_state: "merged",
      source: "host-sync",
    });
  });

  it("records platformHead true when the merged head is the one the platform last pushed", async () => {
    await awaitingReview();
    const platformHead = (
      await db.pool.query<{ platform_head_sha: string }>(
        "SELECT platform_head_sha FROM pull_requests WHERE id = 1",
      )
    ).rows[0].platform_head_sha;
    expect(platformHead).toBe("sha1");
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged", headSha: platformHead })],
    });
    const event = await db.pool.query<{ data: { platformHead?: boolean } }>(
      `SELECT data FROM events
       WHERE type = 'pull-request' AND to_state = 'merged' ORDER BY id DESC LIMIT 1`,
    );
    expect(event.rows[0].data.platformHead).toBe(true);
  });

  it("records platformHead false when a person pushed before merge", async () => {
    await awaitingReview();
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged", headSha: "human-commit" })],
    });
    const event = await db.pool.query<{ data: { platformHead?: boolean } }>(
      `SELECT data FROM events
       WHERE type = 'pull-request' AND to_state = 'merged' ORDER BY id DESC LIMIT 1`,
    );
    expect(event.rows[0].data.platformHead).toBe(false);
  });
});

describe("what waits for a person among the pull requests", () => {
  async function awaitingReview() {
    await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(1));
  }
  const sync = async (pull: Json) => {
    clock.advanceSeconds(61);
    const job = await claimOf("host-sync");
    await worker.complete(job.id, job.attempt, {
      stage: "host-sync",
      pulls: [pull],
    });
  };
  const waiting = async () =>
    (await call("GET", "/blocked")).body.pullRequests as Json[];

  it("lists a spec whose pull request was closed without merge, until it is open or merged again", async () => {
    await awaitingReview();
    expect(await waiting()).toEqual([]);
    await sync(synced(1, { state: "closed" }));
    expect(await waiting()).toEqual([
      {
        specId: 1,
        specDisplayId: "S-1",
        repo: "backend",
        number: 1,
        url: "https://github.com/me/shop/pull/1",
        state: "closed",
        syncError: null,
        hostKind: "github",
        waitingSince: expect.any(String),
        failureSource: null,
        blocking: {
          downstream: [],
          finalization: false,
          pullRequests: false,
          spec: false,
          merge: true,
        },
      },
    ]);
    await sync(synced(1)); // reopened
    expect(await waiting()).toEqual([]);
    expect(await specState()).toBe("awaiting-review");
    await sync(synced(1, { state: "closed" }));
    expect(await waiting()).toHaveLength(1);
    await sync(synced(1, { state: "merged" }));
    expect(await waiting()).toEqual([]);
    expect(await specState()).toBe("merged");
  });

  it("lists a pull request the host keeps refusing, with the reason, until a look works again", async () => {
    await awaitingReview();
    await sync({ id: 1, error: "GitHub answered 404" });
    expect(await waiting()).toMatchObject([
      { specDisplayId: "S-1", state: "open", syncError: "GitHub answered 404" },
    ]);
    await sync(synced(1));
    expect(await waiting()).toEqual([]);
  });

  it("says, when a spec is cancelled, which of its pull requests are still open on the host", async () => {
    await awaitingReview();
    const cancelled = await call("POST", "/specs/1/cancel");
    expect(cancelled.body.pullRequests).toEqual([
      {
        repo: "backend",
        number: 1,
        url: "https://github.com/me/shop/pull/1",
      },
    ]);
  });

  it("names no pull request that is already closed or merged, and none for a spec that never had one", async () => {
    await awaitingReview();
    await sync(synced(1, { state: "closed" }));
    expect((await call("POST", "/specs/1/cancel")).body.pullRequests).toEqual(
      [],
    );
  });

  it("is told to the person by plat spec cancel, which closes nothing itself: a worker with the code host does", async () => {
    await awaitingReview();
    expect(await plat("spec", "cancel", "S-1")).toBe(
      "S-1 is cancelled\n" +
        "a worker that has the code host will close its open pull requests and delete its spec/* and agent/* branches\n" +
        "  backend #1  https://github.com/me/shop/pull/1\n",
    );
  });

  it("does not list the pull requests of a cancelled spec", async () => {
    await awaitingReview();
    await sync(synced(1, { state: "closed" }));
    expect(await waiting()).toHaveLength(1);
    await call("POST", "/specs/1/cancel");
    expect(await waiting()).toEqual([]);
  });

  async function plat(...args: string[]) {
    let out = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
      env: { AFK_API_URL: api.url, AFK_ACCESS_WAIT_SECONDS: "0" },
      readFile: async () => "",
      readDirectory: async () => [],
    };
    expect(await run(args, io)).toBe(0);
    return out;
  }

  it("is said by plat blocked and plat spec show, for a closed pull request and for one that cannot be read", async () => {
    await awaitingReview();
    expect(await plat("blocked")).toBe("nothing is waiting for you\n");

    await sync(synced(1, { state: "closed" }));
    const closed = await plat("blocked");
    expect(closed).toContain(
      "S-1  pull request backend #1 was closed without merge: https://github.com/me/shop/pull/1",
    );
    expect(closed).toContain(
      "reopen it, or rework the spec, or cancel it: plat spec cancel S-1",
    );
    expect(closed).toContain("blocks merge to main");
    expect(await plat("spec", "show", "S-1")).toContain(
      "1. backend #1  closed without merge  ci pending",
    );

    await sync({ id: 1, error: "GitHub answered 404" }); // still closed as far as anyone knows, and now unreadable
    const stuck = await plat("blocked");
    expect(stuck).toContain("pull request backend #1 was closed without merge");
    expect(stuck).toContain("    could not be read: GitHub answered 404");
    expect(await plat("spec", "show", "S-1")).toContain(
      "[could not be read: GitHub answered 404]",
    );

    await sync(synced(1));
    expect(await plat("blocked")).toBe("nothing is waiting for you\n");
  });

  it("is said by plat blocked for an open pull request that cannot be read, without the closed wording", async () => {
    await awaitingReview();
    await sync({ id: 1, error: "GitHub answered 502" });
    const out = await plat("blocked");
    expect(out).toContain(
      "S-1  pull request backend #1 could not be read: GitHub answered 502",
    );
    expect(out).toContain("blocks merge to main");
  });

  it("shows the pull requests in plat spec show before the acceptance pack exists", async () => {
    await settledSpec(["backend", "frontend"]);
    const first = await claimOf("open-pr");
    await worker.complete(first.id, first.attempt, opened(1));
    await claimOf("open-pr"); // the other repo's pull request is still being opened
    await sync(synced(1, { state: "closed" }));
    expect(await specState()).toBe("finalizing");
    const shown = await plat("spec", "show", "S-1");
    expect(shown).not.toContain("acceptance pack:");
    expect(shown).toContain("pull requests:");
    expect(shown).toContain("backend #1  closed without merge");
    expect(await plat("blocked")).toContain(
      "pull request backend #1 was closed without merge",
    );
  });

  it("says closed without merge on the pull request row of the acceptance pack", async () => {
    await awaitingReview();
    await sync(synced(1, { state: "closed" }));
    const view = (await call("GET", "/specs/1")).body;
    expect(view.pullRequests).toMatchObject([{ state: "closed" }]);
  });
});

describe("the acceptance pack", () => {
  const TESTS = [
    { name: "exports a csv", classname: "orders", status: "passed" },
    { name: "rejects an empty range", classname: "orders", status: "failed" },
    { name: "keeps the order", classname: "orders", status: "skipped" },
    { name: "orders > has a header", classname: "", status: "passed" },
  ];
  const stages: StageResults = {
    implement: {
      outcome: "done",
      run: {
        output: {
          status: "done",
          summary: "did it",
          acceptance: {
            "exports orders": ["exports a csv"],
            "empty range is refused": ["orders rejects an empty range"],
            "order is kept": ["keeps the order"],
            "has a header": ["has a header"],
            "has a footer": ["footer test that does not exist"],
          },
          uncertainties: ["not sure the date format is right"],
        },
      },
    },
    review: {
      outcome: "pass",
      run: {
        axis: "standards",
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: ["rename x"],
          scopeCreep: [],
          sources: ["AGENTS.md", "CONTRIBUTING.md"],
          uncertainties: ["the review could not run the export"],
        },
      },
      findings: [{ kind: "suggestion", body: "rename x" }],
      // the Spec axis, a Run of its own
      extraRuns: [
        {
          run: {
            axis: "spec",
            output: {
              verdict: "pass",
              mustFix: [],
              suggestions: [],
              scopeCreep: ["an export flag nobody asked for"],
              uncertainties: ["the ticket does not say the date format"],
            },
          },
          findings: [
            { kind: "scope-creep", body: "an export flag nobody asked for" },
          ],
        },
      ],
    },
    merge: {
      outcome: "merged",
      headSha: "head",
      run: { headSha: "head", durationMs: 4000 },
      gate: {
        commitSha: "head",
        configSha: "cfg",
        commandResults: [
          { name: "setup", exitCode: 0, ms: 1500 },
          { name: "test", exitCode: 0, ms: 2500 },
        ],
        testsTotal: 3,
        testsSkipped: 1,
        testCases: TESTS,
      },
    },
    "final-review": {
      outcome: "pass",
      run: {
        output: {
          verdict: "pass",
          mustFix: [],
          suggestions: [],
          uncertainties: ["migration order"],
        },
      },
    },
  };
  const criteria = [
    "exports orders",
    "empty range is refused",
    "order is kept",
    "has a header",
    "has a footer",
    "nobody named a test",
  ];

  async function packOf() {
    await settledSpec(["backend"], undefined, {
      tickets: [
        ticket("a", "backend", criteria, {
          protected_paths_ok: [".github/workflows/ci.yml"],
        }),
      ],
      stages,
    });
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(7));
    return (await call("GET", "/specs/1")).body;
  }

  it("does not exist before the pull requests are open", async () => {
    await settledSpec(["backend"]);
    expect((await call("GET", "/specs/1")).body.acceptancePack).toBeNull();
  });

  it("is made when the spec starts waiting for a person, and shown with the spec", async () => {
    const view = await packOf();
    expect(view.spec.state).toBe("awaiting-review");
    expect(view.acceptancePack).not.toBeNull();
    expect(view.acceptancePack.repos).toHaveLength(1);
    expect(view.acceptancePack.repos[0].pullRequest).toEqual(
      view.pullRequests[0],
    );
  });

  it("marks a criterion verified only when its named test is in the JUnit report and passed", async () => {
    const { acceptancePack } = await packOf();
    expect(acceptancePack.repos[0].tickets).toHaveLength(1);
    const byText = Object.fromEntries(
      acceptancePack.repos[0].tickets[0].criteria.map((c: Json) => [c.text, c]),
    );
    expect(byText["exports orders"]).toMatchObject({
      status: "verified",
      reason: null,
      tests: ["exports a csv"],
    });
    expect(byText["empty range is refused"]).toMatchObject({
      status: "unverified",
      reason: "failed: orders rejects an empty range",
    });
    expect(byText["order is kept"]).toMatchObject({
      status: "unverified",
      reason: "skipped: keeps the order",
    });
    expect(byText["has a header"]).toMatchObject({ status: "verified" }); // "orders > has a header"
    expect(byText["has a footer"]).toMatchObject({
      status: "unverified",
      reason: "not in the JUnit report: footer test that does not exist",
    });
    expect(byText["nobody named a test"]).toMatchObject({
      status: "unverified",
      reason: "the agent named no test",
    });
  });

  it("shows the Standards sources the review used, including CONTRIBUTING.md", async () => {
    const { acceptancePack } = await packOf();
    expect(acceptancePack.repos[0].standardsSources).toEqual([
      {
        ticket: "T-1",
        run: expect.stringMatching(/^R-\d+$/),
        stage: "review",
        sources: ["AGENTS.md", "CONTRIBUTING.md"],
      },
    ]);
  });

  it("carries the review's findings with what became of them, and every uncertainty", async () => {
    const { acceptancePack } = await packOf();
    expect(acceptancePack.repos[0].findings).toEqual([
      {
        ticket: "T-1",
        run: expect.stringMatching(/^R-\d+$/),
        stage: "review",
        kind: "suggestion",
        body: "rename x",
        resolution: "acceptance-pack",
        axis: "standards",
      },
    ]);
    // scope creep has a list of its own, apart from the other findings
    expect(acceptancePack.repos[0].scopeCreep).toEqual([
      {
        ticket: "T-1",
        run: expect.stringMatching(/^R-\d+$/),
        body: "an export flag nobody asked for",
      },
    ]);
    expect(acceptancePack.repos[0].uncertainties).toEqual([
      { source: "T-1 implement", text: "not sure the date format is right" },
      { source: "T-1 review", text: "the review could not run the export" },
      { source: "T-1 review", text: "the ticket does not say the date format" },
      { source: "S-1 final review", text: "migration order" },
    ]);
  });

  it("after final-fix is done, wrap-up must-fix findings are handed to fix in the pack and pull request, not unhandled", async () => {
    await settledSpec(["backend"], undefined, {
      tickets: [ticket("a", "backend")],
      stages: {
        ...stages,
        "final-review": {
          outcome: "fix",
          findings: [{ kind: "must-fix", body: "names disagree" }],
        },
        "final-fix": { outcome: "done" },
        "final-merge": { outcome: "merged", headSha: "settled" },
      },
    });
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(7));
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    const wrapUp = acceptancePack.repos[0].findings.filter(
      (f: Json) => f.stage === "final-review",
    );
    expect(wrapUp).toEqual([
      {
        ticket: null,
        run: expect.stringMatching(/^R-\d+$/),
        stage: "final-review",
        kind: "must-fix",
        body: "names disagree",
        resolution: "已交给 fix 处理",
        axis: null,
      },
    ]);
    const patch = await claimOf("patch-pr-body");
    const task = (await taskOf(patch)).body;
    expect(task.section).toContain(
      "[已交给 fix 处理] spec final-review must-fix: names disagree",
    );
    expect(task.section).not.toContain("unhandled");
  });

  it("reports the gate of the integration branch with its time, and the protected paths a person approved", async () => {
    const { acceptancePack } = await packOf();
    expect(acceptancePack.repos[0].gate).toEqual({
      commitSha: "head",
      testsTotal: 3,
      testsSkipped: 1,
      durationMs: 4000,
      steps: [
        { name: "setup", exitCode: 0, ms: 1500 },
        { name: "test", exitCode: 0, ms: 2500 },
      ],
    });
    expect(acceptancePack.repos[0].protectedPathApprovals).toEqual([
      { ticket: "T-1", paths: [".github/workflows/ci.yml"] },
    ]);
    expect(acceptancePack.agentSeconds).toBeGreaterThanOrEqual(4);
  });

  it("lists the pull requests in the order to merge them, the repo whose contract is used first, with today's CI and review", async () => {
    // the frontend repo was added first, and uses the backend's contract
    await settledSpec(["frontend", "backend"], undefined, {
      contractPaths: { backend: "openapi.yaml" },
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", undefined, { contract: "contract" }),
      ],
    });
    for (let n = 1; n <= 2; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
    const sync = await claimOf("host-sync");
    await worker.complete(sync.id, sync.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { ci: "success" }), synced(2, { review: "approved" })],
    });
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    expect(
      acceptancePack.repos.map((r: Json) => [
        r.pullRequest.order,
        r.repo,
        r.pullRequest.ci,
        r.pullRequest.review,
      ]),
    ).toEqual([
      [1, "backend", "pending", "approved"],
      [2, "frontend", "success", "none"],
    ]);
  });

  it("opens with the merge order and has a section for each repo, in that order, with its own pull request, gate and tickets", async () => {
    await settledSpec(["frontend", "backend"], undefined, {
      contractPaths: { backend: "openapi.yaml" },
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", ["fe works"], { contract: "contract" }),
      ],
      stages,
    });
    for (let n = 1; n <= 2; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    expect(acceptancePack.mergeOrder).toEqual({
      ordered: ["backend", "frontend"],
      after: { backend: [], frontend: ["backend"] },
      unordered: [],
    });
    expect(acceptancePack.repos.map((r: Json) => r.repo)).toEqual([
      "backend",
      "frontend",
    ]);
    const [backend, frontend] = acceptancePack.repos;
    expect(backend.tickets.map((t: Json) => t.displayId)).toEqual(["T-1"]);
    expect(frontend.tickets.map((t: Json) => t.displayId)).toEqual(["T-2"]);
    expect(frontend.pullRequest).toMatchObject({
      repo: "frontend",
      waitsFor: ["backend"],
    });
    expect(backend.gate).toMatchObject({ commitSha: "head" });
    expect(frontend.gate).toMatchObject({ commitSha: "head" });
  });

  it("verifies a criterion with a test that a fix run added, the last run's naming of it winning", async () => {
    await settledSpec(["backend"], undefined, {
      tickets: [ticket("a", "backend", ["exports orders", "has a header"])],
      stages: {
        ...stages,
        implement: {
          outcome: "done",
          run: {
            output: {
              status: "done",
              summary: "did it",
              acceptance: {
                "exports orders": ["footer test that does not exist"],
              },
              uncertainties: [],
            },
          },
        },
        gate: [
          { outcome: "failed", run: { output: { failureLog: "boom" } } },
          { outcome: "passed" },
        ],
        "gate-fix": {
          outcome: "done",
          run: {
            output: {
              status: "done",
              summary: "fixed",
              acceptance: {
                "exports orders": ["exports a csv"],
                "has a header": ["has a header"],
              },
              uncertainties: [],
            },
          },
        },
      },
    });
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(7));
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    const criteria = acceptancePack.repos[0].tickets[0].criteria;
    expect(criteria).toMatchObject([
      { text: "exports orders", status: "verified", tests: ["exports a csv"] },
      { text: "has a header", status: "verified", tests: ["has a header"] },
    ]);
  });

  it("marks tickets appended after the plan was confirmed, and lists the cancelled ones", async () => {
    await settledSpec(["backend"], undefined, {
      tickets: [ticket("a", "backend"), ticket("b", "backend", ["b works"])],
    });
    // b is cancelled before it ran, a new one is appended and goes through
    await db.pool.query("UPDATE tickets SET state = 'cancelled' WHERE id = 2");
    await db.pool.query("UPDATE tickets SET appended = true WHERE id = 1");
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(7));
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    expect(acceptancePack.repos[0].tickets).toMatchObject([
      { displayId: "T-1", appended: true },
    ]);
    expect(acceptancePack.cancelledTickets).toEqual([
      { displayId: "T-2", title: "Ticket b", repo: "backend" },
    ]);
  });

  it("fills missing arrays on a stored pack that already has repo sections", async () => {
    await packOf();
    await db.pool.query(
      "UPDATE acceptance_packs SET content = $1 WHERE spec_id = 1",
      [
        JSON.stringify({
          generatedAt: "2026-10-01T00:00:00.000Z",
          agentSeconds: 12,
          mergeOrder: { ordered: ["backend"], after: {}, unordered: [] },
          repos: [
            {
              repo: "backend",
              tickets: [
                {
                  displayId: "T-1",
                  title: "Ticket a",
                  appended: false,
                  criteria: [
                    {
                      text: "it works",
                      status: "unverified",
                      reason: null,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    );
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    expect(acceptancePack.cancelledTickets).toEqual([]);
    expect(acceptancePack.repos[0].findings).toEqual([]);
    expect(acceptancePack.repos[0].tickets[0].criteria[0].tests).toEqual([]);
    const stored = await db.pool.query("SELECT content FROM acceptance_packs");
    expect(stored.rows[0].content.cancelledTickets).toBeUndefined();
  });

  it("makes a pack again from the record when the stored one is of the older kind, without repo sections", async () => {
    await packOf();
    await db.pool.query(
      "UPDATE acceptance_packs SET content = $1 WHERE spec_id = 1",
      [
        JSON.stringify({
          generatedAt: "2026-10-01T00:00:00.000Z",
          pullRequests: [],
          tickets: [],
        }),
      ],
    );
    const { acceptancePack } = (await call("GET", "/specs/1")).body;
    expect(acceptancePack.generatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(acceptancePack.repos[0].tickets[0].criteria.length).toBeGreaterThan(
      0,
    );
    const stored = await db.pool.query("SELECT content FROM acceptance_packs");
    expect(Array.isArray(stored.rows[0].content.repos)).toBe(true);
  });

  it("is printed by plat spec show, with the pull requests in merge order and each criterion's verdict", async () => {
    await packOf();
    let out = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
      env: { AFK_API_URL: api.url },
      readFile: async () => "",
      readDirectory: async () => [],
    };
    expect(await run(["spec", "show", "S-1"], io)).toBe(0);
    expect(out).toContain("acceptance pack:");
    expect(out).toContain("1. backend #7  open  ci none  review none");
    expect(out).toContain("[verified] exports orders  (exports a csv)");
    expect(out).toContain(
      "[unverified] empty range is refused  (orders rejects an empty range)  -- failed: orders rejects an empty range",
    );
    expect(out).toContain(
      "[acceptance-pack] T-1 review (standards) suggestion: rename x",
    );
    expect(out).toContain("scope creep (not asked for)");
    expect(out).toMatch(/T-1 R-\d+: an export flag nobody asked for/);
    expect(out).toContain("T-1 implement: not sure the date format is right");
    expect(out).toContain(
      "backend @ head: 3 tests, 1 skipped, 4.0 s (setup 1.5 s, test 2.5 s)",
    );
    expect(out).toContain("T-1: .github/workflows/ci.yml");
  });

  it("opens with the spec only, then queues a patch of each description once every pull request is recorded", async () => {
    await settledSpec(["backend", "frontend"], undefined, {
      contractPaths: { backend: "openapi.yaml" },
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", ["fe works"], { contract: "contract" }),
      ],
    });
    const first = await claimOf("open-pr");
    expect((await taskOf(first)).body.body).not.toContain(
      "afk-acceptance-pack",
    );
    await worker.complete(first.id, first.attempt, opened(1));
    expect(await jobsOf("patch-pr-body")).toEqual([]);
    const second = await claimOf("open-pr");
    await worker.complete(second.id, second.attempt, opened(2));
    expect(await jobsOf("patch-pr-body")).toHaveLength(2);
  });

  it("gives the worker this repo's section, the merge order, and not the other repo's criteria", async () => {
    await settledSpec(["backend", "frontend"], undefined, {
      contractPaths: { backend: "openapi.yaml" },
      tickets: [
        contractTicket("contract", "backend"),
        ticket("fe", "frontend", ["fe works"], { contract: "contract" }),
      ],
    });
    for (let n = 1; n <= 2; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
    const tasks: Json[] = [];
    for (let i = 0; i < 2; i++) {
      const job = await claimOf("patch-pr-body");
      tasks.push((await taskOf(job)).body);
      await worker.complete(job.id, job.attempt, PATCHED);
    }
    const backend = tasks.find((t) => t.repoUrl.includes("backend"));
    const frontend = tasks.find((t) => t.repoUrl.includes("frontend"));
    expect(backend).toMatchObject({ kind: "patch-pr-body", number: 1 });
    expect(backend.section).toContain("## Merge order");
    expect(backend.section).toContain("backend → frontend");
    expect(backend.section).toContain("contract works");
    expect(backend.section).not.toContain("fe works");
    expect(backend.section).toContain("/specs/1/delivery");
    expect(backend.summary).toContain("/specs/1/delivery");
    expect(frontend.section).toContain("fe works");
    expect(frontend.section).not.toContain("contract works");
  });

  it("queues another patch when the pack is saved again", async () => {
    await packOf();
    expect(await jobsOf("patch-pr-body")).toHaveLength(1);
    await inTransaction(db.pool, (client) =>
      saveAcceptancePack(client, 1, clock.now()),
    );
    expect(await jobsOf("patch-pr-body")).toHaveLength(2);
    expect(await jobsOf("patch-pr-body")).toMatchObject([
      { payload: { specId: 1, pullId: 1 } },
      { payload: { specId: 1, pullId: 1 } },
    ]);
  });
});

const CLEANUP_GRACE_SECONDS = 150; // a lease (120 s) and a heartbeat
describe("cleaning up after a cancelled or merged spec", () => {
  async function awaitingReview(repos: string[] = ["backend"]) {
    await settledSpec(repos);
    for (let n = 1; n <= repos.length; n++) {
      const job = await claimOf("open-pr");
      await worker.complete(job.id, job.attempt, opened(n));
    }
  }
  // The sync that was queued first may still be waiting; it is answered with nothing to report.
  async function claimCleanup() {
    clock.advanceSeconds(CLEANUP_GRACE_SECONDS);
    for (let i = 0; i < 8; i++) {
      const job = (await worker.claim()).body.job;
      if (!job) break;
      if (job.type === "spec-cleanup") return job;
      if (await completeIfPatch(job)) continue;
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
    }
    throw new Error("no spec-cleanup job was queued");
  }
  const BACKEND = "https://github.com/me/shop-backend.git";
  const FRONTEND = "https://github.com/me/shop-frontend.git";

  it("queues one cleanup job for the code host when a spec is cancelled, and not again when it is cancelled twice", async () => {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    expect(await call("POST", "/specs/1/cancel")).toMatchObject({
      status: 409,
    });
    expect(await jobsOf("spec-cleanup")).toMatchObject([
      { state: "queued", payload: { specId: 1 }, lock_key: null },
    ]);
  });

  it("tells the worker which open pull requests to close and which branches to delete, in every repo of the spec", async () => {
    await awaitingReview(["backend", "frontend"]);
    const id = await instanceId();
    await call("POST", "/specs/1/cancel");
    const job = await claimCleanup();
    expect((await taskOf(job)).body).toEqual({
      kind: "spec-cleanup",
      pulls: [
        { id: 1, repoUrl: BACKEND, number: 1 },
        { id: 2, repoUrl: FRONTEND, number: 2 },
      ],
      branches: [
        { repoUrl: BACKEND, branch: `spec/${id}/export` },
        { repoUrl: BACKEND, branch: `agent/${id}/T-1` },
        { repoUrl: BACKEND, branch: `agent/${id}/S-1-final` },
        { repoUrl: FRONTEND, branch: `spec/${id}/export` },
        { repoUrl: FRONTEND, branch: `agent/${id}/T-2` },
        { repoUrl: FRONTEND, branch: `agent/${id}/S-1-final` },
      ],
    });
  });

  it("deletes the flat names of a spec that was made before the databases had ids, and nothing that carries an id", async () => {
    await awaitingReview(["backend"]);
    await db.pool.query("UPDATE specs SET branch_namespace = NULL");
    await call("POST", "/specs/1/cancel");
    const job = await claimCleanup();
    expect((await taskOf(job)).body.branches).toEqual([
      { repoUrl: BACKEND, branch: "spec/export" },
      { repoUrl: BACKEND, branch: "agent/T-1" },
      { repoUrl: BACKEND, branch: "agent/S-1-final" },
    ]);
  });

  it("does not ask for a pull request that is already closed or merged to be closed", async () => {
    await awaitingReview(["backend", "frontend"]);
    const sync = await claimOf("host-sync");
    await worker.complete(sync.id, sync.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "closed" }), synced(2)],
    });
    await call("POST", "/specs/1/cancel");
    const task = (await taskOf(await claimCleanup())).body;
    expect(task.pulls).toEqual([{ id: 2, repoUrl: FRONTEND, number: 2 }]);
  });

  it("records the pull requests the worker closed as closed", async () => {
    await awaitingReview(["backend", "frontend"]);
    await call("POST", "/specs/1/cancel");
    const job = await claimCleanup();
    await worker.complete(job.id, job.attempt, {
      stage: "spec-cleanup",
      closed: [1, 2],
    });
    expect((await pulls()).map((p) => p.state)).toEqual(["closed", "closed"]);
  });

  it("cleans up a spec that has been merged too: its branches go, there is no pull request to close", async () => {
    await awaitingReview();
    const sync = await claimOf("host-sync");
    await worker.complete(sync.id, sync.attempt, {
      stage: "host-sync",
      pulls: [synced(1, { state: "merged" })],
    });
    expect(await specState()).toBe("merged");
    const task = (await taskOf(await claimCleanup())).body;
    expect(task.pulls).toEqual([]);
    expect(task.branches).toContainEqual({
      repoUrl: BACKEND,
      branch: `spec/${await instanceId()}/export`,
    });
  });

  it("tries a failed cleanup again, three times in all, and then leaves it", async () => {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    for (let n = 1; n <= 3; n++) {
      const job = await claimCleanup();
      await worker.fail(job.id, job.attempt, "GitHub answered 503");
    }
    expect(await jobsOf("spec-cleanup")).toHaveLength(3);
    expect((await worker.claim()).body.job).toBeNull();
  });

  // Is the cleanup claimable now? Any sync that is due is answered with nothing to report on the way.
  async function cleanupIsDue() {
    for (let i = 0; i < 8; i++) {
      const job = (await worker.claim()).body.job;
      if (!job) return false;
      if (job.type === "spec-cleanup") return true;
      if (await completeIfPatch(job)) continue;
      await worker.complete(job.id, job.attempt, {
        stage: "host-sync",
        pulls: [],
      });
    }
    return false;
  }

  it("starts the cleanup of a cancelled spec only after every job it stopped has been shut out", async () => {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    expect(await cleanupIsDue()).toBe(false);
    clock.advanceSeconds(CLEANUP_GRACE_SECONDS - 1);
    expect(await cleanupIsDue()).toBe(false);
    clock.advanceSeconds(2);
    expect(await cleanupIsDue()).toBe(true);
  });

  it("waits a minute before trying a failed cleanup again", async () => {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    const first = await claimCleanup();
    await worker.fail(first.id, first.attempt, "GitHub answered 503");
    expect((await worker.claim()).body.job).toBeNull();
    clock.advanceSeconds(59);
    expect((await worker.claim()).body.job).toBeNull();
    clock.advanceSeconds(2);
    expect((await worker.claim()).body.job?.type).toBe("spec-cleanup");
  });

  async function failThreeTimes() {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    for (let n = 1; n <= 3; n++) {
      clock.advanceSeconds(CLEANUP_GRACE_SECONDS);
      const job = await claimCleanup();
      await worker.fail(job.id, job.attempt, `GitHub answered 50${n}`);
    }
  }
  const leftover = async () =>
    (await call("GET", "/blocked")).body.cleanups as Json[];

  it("puts a cleanup that failed three times in what waits for a person, with the last error", async () => {
    await awaitingReview();
    await call("POST", "/specs/1/cancel");
    expect(await leftover()).toEqual([]);
    const job = await claimCleanup();
    await worker.fail(job.id, job.attempt, "GitHub answered 501");
    expect(await leftover()).toEqual([]); // it will be tried again
    clock.advanceSeconds(CLEANUP_GRACE_SECONDS);
    for (const n of [2, 3]) {
      const next = await claimCleanup();
      await worker.fail(next.id, next.attempt, `GitHub answered 50${n}`);
      clock.advanceSeconds(CLEANUP_GRACE_SECONDS);
    }
    expect(await leftover()).toEqual([
      {
        specId: 1,
        specDisplayId: "S-1",
        error: "GitHub answered 503",
        hostKind: "github",
        waitingSince: expect.any(String),
        failureSource: "external",
        blocking: {
          downstream: [],
          finalization: false,
          pullRequests: false,
          spec: false,
          merge: false,
        },
      },
    ]);
  });

  it("queues the cleanup again on a person's word, and it leaves the list while it is queued", async () => {
    await failThreeTimes();
    expect((await call("POST", "/specs/1/cleanup")).status).toBe(200);
    expect(
      (
        await db.pool.query(
          "SELECT source, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows.at(-1),
    ).toEqual({ source: "page", action: "retry-cleanup" });
    expect(await leftover()).toEqual([]);
    expect((await call("POST", "/specs/1/cleanup")).status).toBe(409); // one is already waiting
    const job = await claimCleanup();
    await worker.complete(job.id, job.attempt, {
      stage: "spec-cleanup",
      closed: [1],
    });
    expect(await leftover()).toEqual([]);
  });

  it("lists a cleanup that fails again after an earlier one succeeded", async () => {
    await failThreeTimes();
    await call("POST", "/specs/1/cleanup");
    const done = await claimCleanup();
    await worker.complete(done.id, done.attempt, {
      stage: "spec-cleanup",
      closed: [],
    });
    expect(await leftover()).toEqual([]);
    await call("POST", "/specs/1/cleanup");
    const failed = await claimCleanup();
    await worker.fail(failed.id, failed.attempt, "GitHub answered 504");
    expect(await leftover()).toEqual([
      {
        specId: 1,
        specDisplayId: "S-1",
        error: "GitHub answered 504",
        hostKind: "github",
        waitingSince: expect.any(String),
        failureSource: "external",
        blocking: {
          downstream: [],
          finalization: false,
          pullRequests: false,
          spec: false,
          merge: false,
        },
      },
    ]);
  });

  it("does not clean up a spec that is not over", async () => {
    await awaitingReview();
    const refused = await call("POST", "/specs/1/cleanup");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/cancelled or merged/);
  });

  it("is said by plat blocked and can be asked for again with plat spec cleanup", async () => {
    await failThreeTimes();
    let out = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
      env: { AFK_API_URL: api.url, AFK_ACCESS_WAIT_SECONDS: "0" },
      readFile: async () => "",
      readDirectory: async () => [],
    };
    expect(await run(["blocked"], io)).toBe(0);
    expect(out).toContain(
      "S-1  clean-up of the spec did not finish: GitHub answered 503",
    );
    expect(out).toContain("does not block other tickets");
    expect(out).toContain(
      "branches or pull requests may be left on the code host; try again: plat spec cleanup S-1",
    );
    out = "";
    expect(await run(["spec", "cleanup", "S-1"], io)).toBe(0);
    expect(out).toBe("S-1: clean-up queued\n");
  });
});

class EventStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private pending:
    | ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
    | undefined;
  constructor(response: Response) {
    const body = response.body;
    if (!body) throw new Error("no body");
    this.reader = body.getReader();
  }

  private async pull(timeoutMs: number): Promise<void> {
    this.pending ??= this.reader.read();
    const result = await Promise.race([
      this.pending.then((chunk) => ({ kind: "chunk" as const, chunk })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
      ),
    ]);
    if (result.kind === "timeout") return;
    this.pending = undefined;
    if (result.chunk.value) {
      this.buffer += this.decoder.decode(result.chunk.value, { stream: true });
    }
  }

  async nextInvalidate(timeoutMs = 2_000): Promise<Record<string, number>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const parsed = this.takeInvalidate();
      if (parsed) return parsed;
      await this.pull(deadline - Date.now());
    }
    throw new Error(`no invalidate in ${this.buffer}`);
  }

  private takeInvalidate(): Record<string, number> | undefined {
    const match = this.buffer.match(/event: invalidate\ndata: (\{.*\})\n\n/);
    if (!match) return undefined;
    this.buffer = this.buffer.slice((match.index ?? 0) + match[0].length);
    return JSON.parse(match[1] as string) as Record<string, number>;
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function openEvents(): Promise<EventStream> {
  const response = await fetch(`${api.url}/events`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  return new EventStream(response);
}

// Facts the open-pr job stored; a look that repeats them has found nothing new.
const asOpened = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  state: "open" as const,
  draft: false,
  headSha: `sha${id}`,
  ci: "none",
  review: "none",
  ...extra,
});

describe("host-sync snapshots and invalidate", () => {
  async function specWithOpenPr() {
    const settled = await settledSpec(["backend"]);
    const job = await claimOf("open-pr");
    await worker.complete(job.id, job.attempt, opened(1));
    return settled;
  }

  async function look(pulls: Json[]) {
    clock.advanceSeconds(61);
    for (let i = 0; i < 8; i++) {
      const job = (await worker.claim()).body.job;
      if (!job) break;
      if (await completeIfPatch(job)) continue;
      if (job.type === "host-sync") {
        await worker.complete(job.id, job.attempt, {
          stage: "host-sync",
          pulls,
        });
        return;
      }
    }
    throw new Error("no host-sync job");
  }

  it("does not stream invalidate when a look finds the pull request unchanged", async () => {
    await specWithOpenPr();
    const stream = await openEvents();
    try {
      await look([asOpened(1)]);
      await expect(stream.nextInvalidate(200)).rejects.toThrow(/no invalidate/);
    } finally {
      await stream.close();
    }
  });

  it("streams invalidate and notifies when a pull request's state, CI or review changes", async () => {
    const { specId } = await specWithOpenPr();
    const stream = await openEvents();
    try {
      await look([asOpened(1, { ci: "failure" })]);
      expect(await stream.nextInvalidate()).toMatchObject({ specId });

      await look([asOpened(1, { ci: "failure", review: "approved" })]);
      expect(await stream.nextInvalidate()).toMatchObject({ specId });

      // head_sha is not an event (drizzle/0035_events.sql), so a look that only moves head does not invalidate.
      await look([
        asOpened(1, { ci: "failure", review: "approved", headSha: "head-2" }),
      ]);
      await expect(stream.nextInvalidate(200)).rejects.toThrow(/no invalidate/);

      notices.length = 0;
      await look([
        asOpened(1, {
          ci: "failure",
          review: "approved",
          headSha: "head-2",
          state: "closed",
        }),
      ]);
      expect(await stream.nextInvalidate()).toMatchObject({ specId });
      expect(notices).toEqual([
        {
          title: "待处理",
          body: expect.stringMatching(/S-1 Export orders：PR 被关/),
        },
      ]);
    } finally {
      await stream.close();
    }
  });

  it("does not snapshot cancelled or merged specs: a look's queries stay flat", async () => {
    await specWithOpenPr();
    const queries = attachQueryCounter(db.pool);
    await queries.wrapIdle();
    await look([asOpened(1)]);
    queries.reset();
    await look([asOpened(1)]);
    const baseline = queries.count();

    await db.pool.query(
      `INSERT INTO specs (project_id, type, slug, title, state) VALUES
         (1, 'feature', 'old-merged', 'Old merged', 'merged'),
         (1, 'feature', 'old-cancelled', 'Old cancelled', 'cancelled')`,
    );

    queries.reset();
    await look([asOpened(1)]);
    expect(queries.count()).toBeLessThanOrEqual(baseline + 2);
  });

  it("a look's query count does not grow with fifty merged specs", async () => {
    await specWithOpenPr();
    const queries = attachQueryCounter(db.pool);
    await queries.wrapIdle();
    await look([asOpened(1)]);
    queries.reset();
    await look([asOpened(1)]);
    const baseline = queries.count();

    await db.pool.query(
      `INSERT INTO specs (project_id, type, slug, title, state)
       SELECT 1, 'feature', 'merged-' || i, 'Merged ' || i, 'merged'
       FROM generate_series(1, 50) AS i`,
    );

    queries.reset();
    await look([asOpened(1)]);
    expect(queries.count()).toBeLessThanOrEqual(baseline + 2);
  });
});

function attachQueryCounter(pool: pg.Pool) {
  let n = 0;
  const origConnect = pool.connect.bind(pool) as {
    (): Promise<pg.PoolClient>;
    (
      cb: (
        err: Error,
        client: pg.PoolClient,
        done: (release?: unknown) => void,
      ) => void,
    ): void;
  };
  const wrap = (client: pg.PoolClient) => {
    const marked = client as pg.PoolClient & { _qc?: boolean };
    if (marked._qc) return client;
    marked._qc = true;
    const orig = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      n += 1;
      return orig(...(args as Parameters<typeof orig>));
    }) as typeof client.query;
    return client;
  };
  function connect(): Promise<pg.PoolClient>;
  function connect(
    cb: (
      err: Error,
      client: pg.PoolClient,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  function connect(
    cb?: (
      err: Error,
      client: pg.PoolClient,
      done: (release?: unknown) => void,
    ) => void,
  ) {
    if (cb) {
      origConnect((err, client, done) => {
        if (client) wrap(client);
        cb(err, client, done);
      });
      return;
    }
    return origConnect().then(wrap);
  }
  pool.connect = connect as typeof pool.connect;
  return {
    count: () => n,
    reset: () => {
      n = 0;
    },
    wrapIdle: async () => {
      const idle = pool.idleCount;
      const held: pg.PoolClient[] = [];
      for (let i = 0; i < idle; i++) held.push(await origConnect());
      for (const client of held) {
        wrap(client);
        client.release();
      }
    },
  };
}
