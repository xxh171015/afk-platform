import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeClock,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";

let db: TestDatabase;
let api: RunningApi;
let clock: FakeClock;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  clock = new FakeClock();
  api = await listen(testApp({ pool: db.pool, clock: clock.now }));
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

async function improvementSpec(mergePolicy = "auto-improvement") {
  const created = await call("POST", "/projects", {
    name: "shop",
    mergePolicy,
  });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "improvement",
    slug: "s",
    title: "Spec",
  });
  const specId = spec.body.id as number;
  await db.pool.query(
    "UPDATE specs SET state = 'awaiting-review' WHERE id = $1",
    [specId],
  );
  await db.pool.query(
    `UPDATE events SET at = $2
     WHERE spec_id = $1 AND type = 'spec' AND to_state = 'awaiting-review'`,
    [specId, clock.now()],
  );
  return specId;
}

async function openPull(specId: number) {
  await db.pool.query(
    `INSERT INTO pull_requests (
       spec_id, repo_id, number, url, state, draft, ci, review,
       conflicts_with_default, human_comments, head_sha, synced_at
     ) VALUES ($1, 1, 1, 'https://git.example/pr/1', 'open', false, 'success', 'none',
               false, 0, 'abc', $2)`,
    [specId, clock.now()],
  );
}

describe("auto-merge on a spec view", () => {
  it("says whether the spec will auto-merge, when, and why not", async () => {
    const specId = await improvementSpec();
    await openPull(specId);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.status).toBe(200);
    expect(view.body.autoMerge).toEqual({
      policy: "auto-improvement",
      willMerge: true,
      mergeAt: "2026-01-01T00:30:00.000Z",
      reason: null,
      event: null,
    });

    await db.pool.query(
      "UPDATE pull_requests SET human_comments = 1 WHERE spec_id = $1",
      [specId],
    );
    const blocked = await call("GET", `/specs/${specId}`);
    expect(blocked.body.autoMerge).toEqual({
      policy: "auto-improvement",
      willMerge: false,
      mergeAt: null,
      reason: "PR 上有人写过评论",
      event: null,
    });
  });

  it("includes an auto-merged event that already happened", async () => {
    const specId = await improvementSpec();
    await openPull(specId);
    await db.pool.query(
      `INSERT INTO events (spec_id, type, data)
       VALUES ($1, 'auto-merged', '{"url":"https://git.example/pr/1"}')`,
      [specId],
    );
    expect(
      (await call("GET", `/specs/${specId}`)).body.autoMerge.event,
    ).toEqual({ type: "auto-merged", reason: null });
  });

  it("includes an auto-merge-failed event and its reason", async () => {
    const specId = await improvementSpec();
    await openPull(specId);
    await db.pool.query(
      `INSERT INTO events (spec_id, type, reason, data)
       VALUES ($1, 'auto-merge-failed', 'GitHub answered 403', '{"url":"https://git.example/pr/1"}')`,
      [specId],
    );
    expect(
      (await call("GET", `/specs/${specId}`)).body.autoMerge.event,
    ).toEqual({ type: "auto-merge-failed", reason: "GitHub answered 403" });
  });
});
