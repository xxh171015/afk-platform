import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { enqueueJob } from "../jobs/queue.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

// trial-merge (docs/specs/m3-platform.md「trial-merge」): after an integration branch moves, a worker
// merge-trees it against the other specs in the same repo that still have a branch. Conflicts are a hint on both spec pages;
// they do not block, lock, or run a gate.

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
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

const ticket = (key: string, repo = "backend") => ({
  key,
  repo,
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: [`${key} works`],
});

async function projectWithSpecs(slugs: string[]) {
  const project = await call("POST", "/projects", { name: "shop" });
  await call("POST", `/projects/${project.body.id}/repos`, {
    name: "backend",
    url: "https://github.com/me/shop-backend.git",
  });
  const specIds: number[] = [];
  for (const slug of slugs) {
    const spec = await call("POST", "/specs", {
      projectId: project.body.id,
      type: "feature",
      slug,
      title: slug,
    });
    await call(
      "POST",
      `/specs/${spec.body.id}/tickets/import`,
      importBody(spec.body.id, {
        tickets: [ticket(slug)],
      }),
    );
    expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
      200,
    );
    specIds.push(spec.body.id as number);
  }
  return { projectId: project.body.id as number, specIds };
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  lockKey: string | null;
  payload: { stage?: string; ticketId?: number; specId?: number };
}

async function parkExcept(stageOrType: string, ticketId?: number) {
  if (ticketId !== undefined) {
    await db.pool.query(
      `UPDATE jobs SET not_before = '2099-01-01'
       WHERE state = 'queued' AND type <> 'host-sync'
         AND NOT (
           payload->>'stage' = $1 AND (payload->>'ticketId')::int IS NOT DISTINCT FROM $2
         )`,
      [stageOrType, ticketId],
    );
    return;
  }
  await db.pool.query(
    `UPDATE jobs SET not_before = '2099-01-01'
     WHERE state = 'queued' AND type <> 'host-sync'
       AND type <> $1 AND coalesce(payload->>'stage', '') <> $1`,
    [stageOrType],
  );
}

async function unpark() {
  await db.pool.query(
    `UPDATE jobs SET not_before = NULL WHERE not_before = '2099-01-01'`,
  );
}

async function stage(
  expected: string,
  result: Record<string, unknown>,
  ticketId?: number,
): Promise<Claimed> {
  await parkExcept(expected, ticketId);
  const claimed = (await worker.claim()).body.job as Claimed | null;
  await unpark();
  expect(claimed?.payload.stage ?? claimed?.type).toBe(expected);
  const reply = await worker.complete(
    (claimed as Claimed).id,
    (claimed as Claimed).attempt,
    {
      stage: expected,
      ...result,
    },
  );
  expect(reply.status).toBe(200);
  return claimed as Claimed;
}

async function mergeTicket(ticketId: number, headSha: string) {
  await stage("implement", { outcome: "done" }, ticketId);
  await stage("gate", { outcome: "passed" }, ticketId);
  await stage("review", { outcome: "pass" }, ticketId);
  await stage("merge", { outcome: "merged", headSha }, ticketId);
}

async function specView(id: number) {
  return call("GET", `/specs/${id}`);
}

async function trialMergeTask(job: Claimed) {
  const response = await fetch(
    `${api.url}/worker/jobs/${job.id}/trial-merge-task?workerId=${worker.id}&attempt=${job.attempt}`,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

describe("trial-merge", () => {
  it("does not queue a job when the spec is alone in the repo", async () => {
    await projectWithSpecs(["export"]);
    await mergeTicket(1, "head-1");
    const jobs = await db.pool.query(
      "SELECT type FROM jobs WHERE type = 'trial-merge'",
    );
    expect(jobs.rows).toEqual([]);
    expect((await specView(1)).body.potentialConflicts).toEqual([]);
  });

  it("after a merge, both spec pages show the hint, and the job has no lock", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-export");
    const queued = await db.pool.query<{
      type: string;
      lock_key: string | null;
      required_capabilities: string[];
    }>(
      `SELECT type, lock_key, required_capabilities FROM jobs
       WHERE type = 'trial-merge' AND state = 'queued'`,
    );
    expect(queued.rows).toEqual([
      { type: "trial-merge", lock_key: null, required_capabilities: [] },
    ]);

    await stage("trial-merge", {
      peers: [
        {
          specId: specIds[1],
          files: ["src/shared.ts"],
          ourSha: "aaa",
          theirSha: "bbb",
        },
      ],
    });

    const a = (await specView(specIds[0] as number)).body.potentialConflicts;
    const b = (await specView(specIds[1] as number)).body.potentialConflicts;
    expect(a).toEqual([
      {
        specId: specIds[1],
        displayId: `S-${specIds[1]}`,
        title: "ship",
        repo: "backend",
        repoId: 1,
        files: ["src/shared.ts"],
      },
    ]);
    expect(b).toEqual([
      {
        specId: specIds[0],
        displayId: `S-${specIds[0]}`,
        title: "export",
        repo: "backend",
        repoId: 1,
        files: ["src/shared.ts"],
      },
    ]);

    const blocked = await call("GET", "/blocked");
    expect(JSON.stringify(blocked.body)).not.toMatch(/潜在冲突|src\/shared/);
  });

  it("hands the worker this spec's branch and the other live specs in the repo", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-export");
    await parkExcept("trial-merge");
    const job = (await worker.claim()).body.job as Claimed;
    await unpark();
    expect(job.type).toBe("trial-merge");
    const task = await trialMergeTask(job);
    expect(task.status).toBe(200);
    expect(task.body.ours.specId).toBe(specIds[0]);
    expect(task.body.ours.branch).toMatch(/^spec\//);
    expect(task.body.peers).toEqual([
      {
        specId: specIds[1],
        branch: expect.stringMatching(/^spec\//),
      },
    ]);
    await worker.complete(job.id, job.attempt, {
      stage: "trial-merge",
      peers: [
        {
          specId: specIds[1],
          files: ["src/shared.ts"],
          ourSha: "aaa",
          theirSha: "bbb",
        },
      ],
    });
  });

  it("clears the hint when a later check finds no conflict", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-1");
    await stage("trial-merge", {
      peers: [
        {
          specId: specIds[1],
          files: ["src/shared.ts"],
          ourSha: "aaa",
          theirSha: "bbb",
        },
      ],
    });
    expect(
      (await specView(specIds[0] as number)).body.potentialConflicts,
    ).toHaveLength(1);

    await mergeTicket(2, "head-2");
    await stage("trial-merge", {
      peers: [
        {
          specId: specIds[0],
          files: [],
          ourSha: "ccc",
          theirSha: "ddd",
        },
      ],
    });
    expect(
      (await specView(specIds[0] as number)).body.potentialConflicts,
    ).toEqual([]);
    expect(
      (await specView(specIds[1] as number)).body.potentialConflicts,
    ).toEqual([]);
  });

  it("clears the hint when one of the specs is cancelled", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-1");
    await stage("trial-merge", {
      peers: [
        {
          specId: specIds[1],
          files: ["src/shared.ts"],
          ourSha: "aaa",
          theirSha: "bbb",
        },
      ],
    });
    expect((await call("POST", `/specs/${specIds[1]}/cancel`)).status).toBe(
      200,
    );
    expect(
      (await specView(specIds[0] as number)).body.potentialConflicts,
    ).toEqual([]);
  });

  it("does not restore a hint when a late trial-merge names a cancelled spec", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-1");
    await stage("trial-merge", {
      peers: [
        {
          specId: specIds[1],
          files: ["src/shared.ts"],
          ourSha: "aaa",
          theirSha: "bbb",
        },
      ],
    });
    expect((await call("POST", `/specs/${specIds[1]}/cancel`)).status).toBe(
      200,
    );
    await enqueueJob(db.pool, {
      type: "trial-merge",
      payload: {
        stage: "trial-merge",
        specId: specIds[0],
        repoId: 1,
      },
      idempotencyKey: "S-1:repo-1:trial-merge:late",
    });
    await parkExcept("trial-merge");
    const job = (await worker.claim()).body.job as Claimed;
    await unpark();
    expect(
      (
        await worker.complete(job.id, job.attempt, {
          stage: "trial-merge",
          peers: [
            {
              specId: specIds[1],
              files: ["src/shared.ts"],
              ourSha: "aaa",
              theirSha: "bbb",
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (await specView(specIds[0] as number)).body.potentialConflicts,
    ).toEqual([]);
  });

  it("does not unwind a merge when the trial-merge job fails", async () => {
    const { specIds } = await projectWithSpecs(["export", "ship"]);
    await mergeTicket(1, "head-1");
    const ticket = await db.pool.query<{ state: string }>(
      "SELECT state FROM tickets WHERE spec_id = $1",
      [specIds[0]],
    );
    expect(ticket.rows[0]?.state).toBe("done");

    await parkExcept("trial-merge");
    const job = (await worker.claim()).body.job as Claimed;
    await unpark();
    expect(job.type).toBe("trial-merge");
    expect(
      (await worker.fail(job.id, job.attempt, "clone failed")).status,
    ).toBe(200);

    expect(
      (
        await db.pool.query<{ state: string }>(
          "SELECT state FROM tickets WHERE spec_id = $1",
          [specIds[0]],
        )
      ).rows[0]?.state,
    ).toBe("done");
    expect((await specView(specIds[0] as number)).body.spec.state).not.toBe(
      "paused",
    );
    expect(
      (await specView(specIds[0] as number)).body.potentialConflicts,
    ).toEqual([]);
  });

  it("coalesces later advances onto one queued trial-merge", async () => {
    const project = await call("POST", "/projects", { name: "shop" });
    await call("POST", `/projects/${project.body.id}/repos`, {
      name: "backend",
      url: "https://github.com/me/shop-backend.git",
    });
    const a = await call("POST", "/specs", {
      projectId: project.body.id,
      type: "feature",
      slug: "export",
      title: "export",
    });
    const b = await call("POST", "/specs", {
      projectId: project.body.id,
      type: "feature",
      slug: "ship",
      title: "ship",
    });
    await call(
      "POST",
      `/specs/${a.body.id}/tickets/import`,
      importBody(a.body.id, {
        tickets: [ticket("a1"), ticket("a2")],
      }),
    );
    await call(
      "POST",
      `/specs/${b.body.id}/tickets/import`,
      importBody(b.body.id, { tickets: [ticket("b")] }),
    );
    expect((await call("POST", `/specs/${a.body.id}/confirm`)).status).toBe(
      200,
    );
    expect((await call("POST", `/specs/${b.body.id}/confirm`)).status).toBe(
      200,
    );

    await mergeTicket(1, "head-a1");
    const first = await db.pool.query<{
      id: number;
      payload: { headSha: string };
    }>(
      `SELECT id, payload FROM jobs WHERE type = 'trial-merge' AND state = 'queued'`,
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.payload.headSha).toBe("head-a1");

    await mergeTicket(2, "head-a2");
    const still = await db.pool.query<{
      id: number;
      payload: { headSha: string };
    }>(
      `SELECT id, payload FROM jobs WHERE type = 'trial-merge' AND state = 'queued'`,
    );
    expect(still.rows).toEqual([
      {
        id: first.rows[0]?.id,
        payload: expect.objectContaining({ headSha: "head-a2" }),
      },
    ]);
  });
});
