import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(createApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// Replies are checked field by field below; their exact shapes are the generated client's business.
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
  return {
    status: response.status,
    body: (await response.json()) as Json,
  };
}

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

async function runningSpec(
  tickets: Record<string, unknown>[],
  project: Record<string, unknown> = {},
) {
  const created = await call("POST", "/projects", { name: "shop", ...project });
  await call("POST", `/projects/${created.body.id}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "s",
    title: "Spec",
  });
  expect(
    (
      await call(
        "POST",
        `/specs/${spec.body.id}/tickets/import`,
        importBody(spec.body.id, { tickets }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${spec.body.id}/confirm`)).status).toBe(
    200,
  );
  return spec.body.id as number;
}

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId: number };
}
async function stage(expected: string, result: Record<string, unknown>) {
  const job = (await worker.claim()).body.job as Claimed | null;
  expect(job?.payload.stage).toBe(expected);
  await worker.complete((job as Claimed).id, (job as Claimed).attempt, {
    stage: expected,
    ...result,
  });
  return job as Claimed;
}
const row = async (id: number) =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason, fix_counts, reviewed, restart, allowed_protected_paths FROM tickets WHERE id = $1",
      [id],
    )
  ).rows[0];
const states = async () =>
  (
    await db.pool.query(
      "SELECT id, state, blocked_reason FROM tickets ORDER BY id",
    )
  ).rows.map(
    (r) =>
      `${r.id}:${r.state}${r.blocked_reason ? `/${r.blocked_reason}` : ""}`,
  );

const GAVE_UP = {
  outcome: "agent-gave-up",
  run: {
    output: {
      status: "cannot-proceed",
      blockedReason: "agent-gave-up",
      detail: "needs a decision",
    },
  },
};
const DONE = { outcome: "done" };

describe("retry", () => {
  async function blockedAfterFixes() {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "boom" } },
    });
    await stage("gate-fix", DONE);
    await stage("gate", {
      outcome: "failed",
      run: { output: { failureLog: "still boom" } },
    });
    expect(await row(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "gate-failed",
      fix_counts: { "gate-fix": 1, "review-fix": 0, "merge-fix": 0 },
    });
    return specId;
  }

  it("continue keeps the branch, clears the fix counts and the review, and the ticket is queued again", async () => {
    await blockedAfterFixes();
    const result = await call("POST", "/tickets/1/retry", { mode: "continue" });
    expect(result).toMatchObject({ status: 200, body: { state: "queued" } }); // pending, and the scheduler took it
    expect(await row(1)).toMatchObject({
      state: "queued",
      blocked_reason: null,
      reviewed: false,
      restart: false,
      fix_counts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
    });
    // a new implement job, under a new idempotency key
    const keys = await db.pool.query(
      "SELECT idempotency_key FROM jobs WHERE payload->>'stage' = 'implement' ORDER BY id",
    );
    expect(keys.rows.map((r) => r.idempotency_key)).toEqual([
      "T-1:1:implement:1",
      "T-1:1:implement:2",
    ]);
  });

  it("restart asks the next implement run to start from the integration branch, once", async () => {
    await blockedAfterFixes();
    await call("POST", "/tickets/1/retry", { mode: "restart" });
    expect((await row(1)).restart).toBe(true);
    const job = (await worker.claim()).body.job as Claimed;
    const bundle = await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    expect(bundle.ticket.restart).toBe(true);
    await worker.complete(job.id, job.attempt, {
      stage: "implement",
      outcome: "done",
    });
    expect((await row(1)).restart).toBe(false); // the restart has been carried out
  });

  it("only a blocked ticket can be retried", async () => {
    await runningSpec([ticket("a")]);
    const result = await call("POST", "/tickets/1/retry", { mode: "continue" });
    expect(result.status).toBe(409);
    expect(
      (await call("POST", "/tickets/99/retry", { mode: "continue" })).status,
    ).toBe(404);
    expect(
      (await call("POST", "/tickets/1/retry", { mode: "later" })).status,
    ).toBe(400);
  });

  it("starts the tickets behind a retried one when it finishes, like any other", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/retry", { mode: "continue" });
    await stage("implement", DONE);
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "h" });
    expect(await states()).toEqual(["1:done", "2:queued"]);
  });
});

describe("retry note", () => {
  async function nextBundle() {
    const job = (await worker.claim()).body.job as Claimed;
    const bundle = await fetch(
      `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
    ).then((r) => r.json());
    return { job, bundle };
  }

  it("goes on the next Run's bundle, does not bump the content version, and is gone on a later retry that has none", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    expect((await call("GET", "/tickets/1")).body.ticket.contentVersion).toBe(
      1,
    );

    const note = "use the helper in src/orders/csv.ts";
    await call("POST", "/tickets/1/retry", { mode: "continue", note });
    expect((await call("GET", "/tickets/1")).body.ticket.contentVersion).toBe(
      1,
    );

    const first = await nextBundle();
    expect(first.bundle.note).toBe(note);
    expect(first.bundle.ticket.file).not.toContain(note);
    expect(first.bundle.ticket.contentVersion).toBe(1);

    await worker.complete(first.job.id, first.job.attempt, {
      stage: "implement",
      ...GAVE_UP,
    });
    await call("POST", "/tickets/1/retry", { mode: "continue", note: "   " });
    const second = await nextBundle();
    expect(second.bundle.note).toBeNull();
  });
});

describe("editing a ticket", () => {
  const fileOf = async (id: number, query = "") =>
    (await call("GET", `/tickets/${id}${query}`)).body.ticket.file as string;
  // Edits the ticket's own file: each [from, to] is replaced once in it
  const editFile = async (id: number, ...changes: [string, string][]) => {
    let file = await fileOf(id);
    for (const [from, to] of changes) {
      expect(file).toContain(from);
      file = file.replace(from, to);
    }
    return call("POST", `/tickets/${id}/edit`, { file });
  };
  const bundleOf = async (job: Claimed) =>
    (await (
      await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      )
    ).json()) as Json;
  const version = async (id: number) =>
    (
      await db.pool.query("SELECT content_version FROM tickets WHERE id = $1", [
        id,
      ])
    ).rows[0].content_version;

  it("changes a blocked ticket's content, keeps it blocked, and the run after a retry reads the new file", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    expect(await row(1)).toMatchObject({ state: "blocked" });

    const edited = await editFile(
      1,
      ["title: Ticket a", "title: Better title"],
      ["- src/a/**", "- src/new/**"],
      [
        "protected_paths_ok: []",
        "protected_paths_ok:\n  - openapi/openapi.yaml",
      ],
      ["- [ ] it works", "- [ ] it works\n- [ ] and is fast"],
    );

    expect(edited).toMatchObject({
      status: 200,
      body: { id: 1, contentVersion: 2, changed: true },
    });
    expect(await row(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "agent-gave-up",
    });
    expect(
      (await call("POST", "/tickets/1/retry", { mode: "continue" })).status,
    ).toBe(200);
    const job = (await worker.claim()).body.job as Claimed;
    const bundle = await bundleOf(job);
    expect(bundle.ticket).toMatchObject({
      title: "Better title",
      acceptanceCriteria: ["it works", "and is fast"],
      modules: ["src/new/**"],
      contentVersion: 2,
    });
    // the agent reads exactly what the API shows
    expect(bundle.ticket.file).toBe(await fileOf(1));
    expect(bundle.ticket.file).toContain("id: T-1\nversion: 2\n");
    expect(bundle.allowedProtectedPaths).toEqual(["openapi/openapi.yaml"]);
    const run = await db.pool.query(
      "SELECT ticket_version FROM runs WHERE job_id = $1",
      [job.id],
    );
    expect(run.rows[0].ticket_version).toBe(2);
  });

  it("changes a pending ticket, and it starts with the new content", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    expect(
      (await editFile(2, ["title: Ticket b", "title: Renamed b"])).body
        .contentVersion,
    ).toBe(2);
    await stage("implement", DONE);
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "h" });
    const job = (await worker.claim()).body.job as Claimed;
    expect(job.payload.ticketId).toBe(2);
    expect((await bundleOf(job)).ticket.title).toBe("Renamed b");
  });

  it("writes the dependencies of the file as T-<n> and the body as it was imported", async () => {
    await runningSpec([
      ticket("a", { body: "Details of a." }),
      ticket("b", { blocked_by: ["a"] }),
    ]);
    const file = await fileOf(2);
    expect(file).toMatch(/^---\nid: T-2\nversion: 1\ntitle: Ticket b\n/);
    expect(file).toContain("blocked_by:\n  - T-1\n");
    expect(await fileOf(1)).toContain("Details of a.");
    expect((await call("GET", "/tickets/1")).body.ticket.file).toBe(
      await fileOf(1),
    );
  });

  it("refuses to change the repo, type, edges, refs or environment, naming the field", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    for (const [field, line] of [
      ["repo", "repo: frontend"],
      ["type", "type: contract"],
      ["blocked_by", "blocked_by: []"],
      ["contract", "contract:\n  - T-1"],
      ["refs", "refs:\n  - backend"],
      ["environment", "environment:\n  - backend"],
    ] as const) {
      const file = (await fileOf(2)).replace(
        /^(---\n(?:.*\n)*?)(?=---\n)/,
        (front) =>
          `${front.replace(new RegExp(`^${field}:.*\\n(  - .*\\n)*`, "m"), "")}${line}\n`,
      );
      const result = await call("POST", "/tickets/2/edit", { file });
      expect(result.status).toBe(422);
      expect(result.body.error).toMatch(new RegExp(`^${field}: `));
      expect(result.body.error).toMatch(/cancel.*append/);
    }
    expect(await version(2)).toBe(1);
  });

  it("takes the fixed fields left out, refuses another ticket's file, and changes nothing when the file says the same", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const body = (await fileOf(2)).split("\n---\n")[1] as string;
    const short = `---\ntitle: New\nmodules:\n  - src/b/**\n---\n${body}`;
    expect(
      (await call("POST", "/tickets/2/edit", { file: short })).status,
    ).toBe(200);
    expect((await fileOf(2)).includes("title: New")).toBe(true);

    const other = await call("POST", "/tickets/2/edit", {
      file: (await fileOf(1)).replace("title: Ticket a", "title: X"),
    });
    expect(other.status).toBe(422);
    expect(other.body.error).toMatch(/id: .*T-1.*T-2/);

    const same = await call("POST", "/tickets/2/edit", {
      file: await fileOf(2),
    });
    expect(same).toMatchObject({
      status: 200,
      body: { contentVersion: 2, changed: false },
    });
    expect(await version(2)).toBe(2);
    expect(
      (await db.pool.query("SELECT 1 FROM ticket_versions WHERE ticket_id = 2"))
        .rowCount,
    ).toBe(2);
  });

  it("refuses a file that does not follow the template, and writes nothing", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const file = (await fileOf(2)).replace("- [ ] it works", "it works");
    const result = await call("POST", "/tickets/2/edit", { file });
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/single-line/);
    expect(await version(2)).toBe(1);
  });

  it("refuses a ticket that is queued, running, merging, done or cancelled", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    const file = await fileOf(1);
    for (const state of ["queued", "running", "merging", "done", "cancelled"]) {
      await db.pool.query("UPDATE tickets SET state = $1 WHERE id = 1", [
        state,
      ]);
      const result = await call("POST", "/tickets/1/edit", { file });
      expect(result.status).toBe(409);
      expect(result.body.error).toMatch(new RegExp(state));
    }
    expect(await version(1)).toBe(1);
    expect((await call("POST", "/tickets/99/edit", { file })).status).toBe(404);
  });

  it("lets the snapshot of the current version follow protected paths approved by allow-paths", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/allow-paths", {
      paths: ["openapi/openapi.yaml"],
    });
    const snapshot = await db.pool.query(
      "SELECT allowed_protected_paths FROM ticket_versions WHERE ticket_id = 1 AND version = 1",
    );
    expect(snapshot.rows[0].allowed_protected_paths).toEqual([
      "openapi/openapi.yaml",
    ]);
  });

  it("keeps a snapshot of every version, and shows an old one with the history", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await editFile(
      2,
      ["title: Ticket b", "title: Second"],
      ["- [ ] it works", "- [ ] changed"],
    );
    await editFile(2, ["title: Second", "title: Third"]);

    const current = (await call("GET", "/tickets/2")).body;
    expect(current.ticket).toMatchObject({ title: "Third", contentVersion: 3 });
    expect(current.versions.map((v: Json) => v.version)).toEqual([1, 2, 3]);

    const first = (await call("GET", "/tickets/2?version=1")).body;
    expect(first.ticket).toMatchObject({
      title: "Ticket b",
      acceptanceCriteria: ["it works"],
      contentVersion: 1,
    });
    expect(first.ticket.file).toContain("version: 1\ntitle: Ticket b\n");
    const second = (await call("GET", "/tickets/2?version=2")).body;
    expect(second.ticket).toMatchObject({
      title: "Second",
      acceptanceCriteria: ["changed"],
      contentVersion: 2,
    });
    expect(second.ticket.file).toBe(await fileOf(2, "?version=2"));
    expect((await call("GET", "/tickets/2?version=9")).status).toBe(404);
    expect((await call("GET", "/tickets/1")).body.versions).toHaveLength(1);
  });
});

describe("a review of two axes", () => {
  const axisOutput = (
    verdict: "pass" | "fix",
    over: Record<string, unknown> = {},
  ) => ({
    verdict,
    mustFix: [],
    suggestions: [],
    scopeCreep: [],
    uncertainties: [],
    ...over,
  });
  // The worker's report of a review: the Standards run is the job's own, the Spec run comes beside it.
  async function reviewed(
    standards: ReturnType<typeof axisOutput>,
    spec: ReturnType<typeof axisOutput>,
    outcome: "pass" | "fix",
  ) {
    await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", { outcome: "passed" });
    const findingsOf = (o: ReturnType<typeof axisOutput>) => [
      ...(o.mustFix as { file: string; problem: string }[]).map((m) => ({
        kind: "must-fix",
        body: `${m.file} ${m.problem}`,
      })),
      ...(o.suggestions as string[]).map((body) => ({
        kind: "suggestion",
        body,
      })),
      ...(o.scopeCreep as string[]).map((body) => ({
        kind: "scope-creep",
        body,
      })),
    ];
    await stage("review", {
      outcome,
      run: { axis: "standards", output: standards },
      findings: findingsOf(standards),
      extraRuns: [
        {
          run: { axis: "spec", output: spec },
          findings: findingsOf(spec),
        },
      ],
    });
  }

  it("records a Run for each axis, and a finding with the axis of the Run it came from", async () => {
    await reviewed(
      axisOutput("fix", {
        mustFix: [{ file: "a.ts", problem: "naming" }],
        suggestions: ["a smell"],
      }),
      axisOutput("pass", { scopeCreep: ["an extra flag"] }),
      "fix",
    );
    const runs = await db.pool.query(
      "SELECT stage, axis, attempt, result FROM runs WHERE stage = 'review' ORDER BY id",
    );
    expect(runs.rows).toEqual([
      { stage: "review", axis: "standards", attempt: 1, result: "fix" },
      { stage: "review", axis: "spec", attempt: 1, result: "fix" },
    ]);
    const view = (await call("GET", "/tickets/1")).body;
    expect(
      view.runs
        .filter((r: Json) => r.stage === "review")
        .map((r: Json) => r.axis),
    ).toEqual(["standards", "spec"]);
    expect(
      view.findings.map((f: Json) => `${f.axis}:${f.kind}:${f.resolution}`),
    ).toEqual([
      "standards:must-fix:unhandled",
      "standards:suggestion:acceptance-pack",
      "spec:scope-creep:acceptance-pack",
    ]);
  });

  it("starts an axis Run sent without a start time when the job's own Run started, since they run side by side", async () => {
    await reviewed(axisOutput("pass"), axisOutput("pass"), "pass");
    const runs = await db.pool.query(
      "SELECT axis, started_at FROM runs WHERE stage = 'review' ORDER BY id",
    );
    expect(runs.rows[0].started_at).toBeInstanceOf(Date);
    expect(runs.rows[1]).toEqual({
      axis: "spec",
      started_at: runs.rows[0].started_at,
    });
  });

  it("gives a review-fix the must-fix of both axes in review.json, each with its axis", async () => {
    await reviewed(
      axisOutput("fix", { mustFix: [{ file: "s.ts", problem: "style" }] }),
      axisOutput("fix", { mustFix: [{ file: "t.ts", problem: "missing" }] }),
      "fix",
    );
    const job = (await worker.claim()).body.job as Claimed;
    expect(job.payload.stage).toBe("review-fix");
    const bundle = (await (
      await fetch(
        `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
      )
    ).json()) as Json;
    expect(bundle.review).toMatchObject({
      verdict: "fix",
      mustFix: [
        { axis: "standards", file: "s.ts", problem: "style" },
        { axis: "spec", file: "t.ts", problem: "missing" },
      ],
    });
    expect(bundle.review.standards.mustFix).toHaveLength(1);
    expect(bundle.review.spec.mustFix).toHaveLength(1);
  });

  it("keeps scope creep as a finding of the Spec axis that no fix is asked to handle", async () => {
    await reviewed(
      axisOutput("pass"),
      axisOutput("pass", { scopeCreep: ["an extra flag"] }),
      "pass",
    );
    const view = (await call("GET", "/tickets/1")).body;
    expect(
      view.findings.map((f: Json) => `${f.axis}:${f.kind}:${f.resolution}`),
    ).toEqual(["spec:scope-creep:acceptance-pack"]);
    // the review passed: the next step is the merge, not a fix
    expect(((await worker.claim()).body.job as Claimed).payload.stage).toBe(
      "merge",
    );
  });
});

describe("approve-protected", () => {
  async function blockedByProtectedPath() {
    await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", {
      outcome: "protected-path-changed",
      run: {
        output: { unapproved: [".github/workflows/ci.yml", "tsconfig.json"] },
      },
    });
    expect(await row(1)).toMatchObject({
      state: "blocked",
      blocked_reason: "protected-path-changed",
    });
  }

  it("adds the paths the gate found to the ticket's approved ones and goes on from the gate", async () => {
    await blockedByProtectedPath();
    const result = await call("POST", "/tickets/1/approve-protected");
    expect(result).toMatchObject({
      status: 200,
      body: { approved: [".github/workflows/ci.yml", "tsconfig.json"] },
    });
    expect(await row(1)).toMatchObject({
      state: "running",
      blocked_reason: null,
      allowed_protected_paths: [".github/workflows/ci.yml", "tsconfig.json"],
    });
    const next = (await worker.claim()).body.job as Claimed;
    expect(next.payload.stage).toBe("gate"); // not implement: the work is kept
    const bundle = await fetch(
      `${api.url}/worker/jobs/${next.id}/bundle?workerId=w1&attempt=${next.attempt}`,
    ).then((r) => r.json());
    expect(bundle.allowedProtectedPaths).toEqual([
      ".github/workflows/ci.yml",
      "tsconfig.json",
    ]);
  });

  it("carries on to done afterwards", async () => {
    await blockedByProtectedPath();
    await call("POST", "/tickets/1/approve-protected");
    await stage("gate", { outcome: "passed" });
    await stage("review", { outcome: "pass" });
    await stage("merge", { outcome: "merged", headSha: "h" });
    expect(await states()).toEqual(["1:done"]);
  });

  it("is for protected-path-changed only", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    const result = await call("POST", "/tickets/1/approve-protected");
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/protected-path-changed/);
    expect((await row(1)).state).toBe("blocked");
    expect((await call("POST", "/tickets/99/approve-protected")).status).toBe(
      404,
    );
  });

  it("refuses when the gate left no record of the paths", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", { outcome: "protected-path-changed" });
    expect((await call("POST", "/tickets/1/approve-protected")).status).toBe(
      409,
    );
  });
});

describe("allow-paths", () => {
  it("adds paths to a blocked ticket's approved ones, and a retry carries them to the agent", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    const result = await call("POST", "/tickets/1/allow-paths", {
      paths: [".github/CODEOWNERS"],
    });
    expect(result).toMatchObject({
      status: 200,
      body: { allowed: [".github/CODEOWNERS"] },
    });
    const view = await call("GET", "/tickets/1");
    expect(view.body.ticket.allowedProtectedPaths).toEqual([
      ".github/CODEOWNERS",
    ]);
    expect(await row(1)).toMatchObject({
      state: "blocked", // approving does not run it; a person retries
      allowed_protected_paths: [".github/CODEOWNERS"],
    });
    await call("POST", "/tickets/1/retry", { mode: "continue" });
    const next = (await worker.claim()).body.job as Claimed;
    const bundle = await fetch(
      `${api.url}/worker/jobs/${next.id}/bundle?workerId=w1&attempt=${next.attempt}`,
    ).then((r) => r.json());
    expect(bundle.allowedProtectedPaths).toEqual([".github/CODEOWNERS"]);
  });

  it("refuses a ticket that is not blocked, an unknown one, and a bad list", async () => {
    await runningSpec([ticket("a")]);
    const paths = { paths: [".github/CODEOWNERS"] };
    const running = await call("POST", "/tickets/1/allow-paths", paths);
    expect(running.status).toBe(409);
    expect(running.body.error).toMatch(/only a blocked ticket/);
    expect((await row(1)).allowed_protected_paths).toEqual([]);
    expect((await call("POST", "/tickets/99/allow-paths", paths)).status).toBe(
      404,
    );
    for (const bad of [{ paths: [] }, { paths: [""] }, {}]) {
      expect((await call("POST", "/tickets/1/allow-paths", bad)).status).toBe(
        400,
      );
    }
  });

  it("keeps what was approved before and adds each path once", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/allow-paths", { paths: ["a.txt"] });
    const again = await call("POST", "/tickets/1/allow-paths", {
      paths: ["a.txt", "b.txt"],
    });
    expect(again.body.allowed).toEqual(["a.txt", "b.txt"]);
  });
});

describe("cancel", () => {
  // a -> b -> c, and d on its own
  const chain = () => [
    ticket("a"),
    ticket("b", { blocked_by: ["a"] }),
    ticket("c", { blocked_by: ["b"] }),
    ticket("d"),
  ];

  it("puts the tickets that waited for it into blocked (upstream-cancelled) and leaves the rest alone", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP); // a blocked
    const result = await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(result.body).toEqual({
      cancelled: ["T-1"],
      blocked: ["T-2"],
      skipped: [],
    });
    expect(await states()).toEqual([
      "1:cancelled",
      "2:blocked/upstream-cancelled",
      "3:pending",
      "4:queued",
    ]);
  });

  it("with cascade cancels everything below it", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP);
    const result = await call("POST", "/tickets/1/cancel", { cascade: true });
    expect(result.body).toEqual({
      cancelled: ["T-1", "T-2", "T-3"],
      blocked: [],
      skipped: [],
    });
    expect(await states()).toEqual([
      "1:cancelled",
      "2:cancelled",
      "3:cancelled",
      "4:queued",
    ]);
  });

  it("a ticket put into blocked by a cancel can then be cancelled itself, or retried", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(
      (await call("POST", "/tickets/2/cancel", { cascade: false })).body,
    ).toMatchObject({ cancelled: ["T-2"], blocked: ["T-3"] });
    // ticket 3 would wait for ticket 2, which is gone: a retry cannot help it
    const retry = await call("POST", "/tickets/3/retry", { mode: "continue" });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/T-2, which was cancelled/);
  });

  it("says which downstream tickets it left alone when they are already under way", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 2"); // cannot normally happen: a stand-in
    const result = await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(result.body).toEqual({
      cancelled: ["T-1"],
      blocked: [],
      skipped: ["T-2"],
    });
  });

  it("a ticket blocked by a cancelled upstream has no brief: no run is to blame", async () => {
    await runningSpec(chain());
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/cancel", { cascade: false });
    const view = await call("GET", "/tickets/2");
    expect(view.body.ticket).toMatchObject({
      state: "blocked",
      blockedReason: "upstream-cancelled",
      brief: null,
    });
    const queue = await call("GET", "/blocked");
    expect(
      queue.body.tickets.find((t: Json) => t.displayId === "T-2").brief,
    ).toBeNull();
  });

  it("a pending ticket can be cancelled before it ever started", async () => {
    await runningSpec(chain());
    expect(
      (await call("POST", "/tickets/3/cancel", { cascade: false })).status,
    ).toBe(200);
    expect((await states())[2]).toBe("3:cancelled");
  });

  it("refuses a ticket that is under way or finished", async () => {
    await runningSpec(chain());
    expect(
      (await call("POST", "/tickets/1/cancel", { cascade: false })).status,
    ).toBe(409); // queued
    await stage("implement", DONE);
    expect(
      (await call("POST", "/tickets/1/cancel", { cascade: true })).status,
    ).toBe(409); // running
    expect(
      (await call("POST", "/tickets/99/cancel", { cascade: false })).status,
    ).toBe(404);
  });

  it("frees a slot, so a waiting ticket can start", async () => {
    await runningSpec([ticket("a"), ticket("b"), ticket("c")], {
      limits: { projectConcurrency: 1, repoConcurrency: 1 },
    });
    await stage("implement", GAVE_UP); // a blocked, b is now running room
    // b already took the slot; cancel a, and c still waits for b
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await states()).toEqual(["1:cancelled", "2:queued", "3:pending"]);
  });

  it("leaves a downstream ticket that is already under way, and says so", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 2"); // cannot normally happen: a stand-in
    const result = await call("POST", "/tickets/1/cancel", { cascade: true });
    expect(result.body).toEqual({
      cancelled: ["T-1"],
      blocked: [],
      skipped: ["T-2"],
    });
  });
});

describe("cancelling a spec", () => {
  const specState = async () =>
    (await db.pool.query("SELECT state FROM specs")).rows[0].state;
  const openJobs = async () =>
    Number(
      (
        await db.pool.query(
          "SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'running') AND type <> 'spec-cleanup'",
        )
      ).rows[0].n,
    );
  const cleanups = async () =>
    (
      await db.pool.query(
        "SELECT payload FROM jobs WHERE type = 'spec-cleanup' AND state = 'queued'",
      )
    ).rows.map((r) => r.payload);

  it("cancels every unfinished ticket, stops the jobs, and the scheduler hands out nothing more", async () => {
    const specId = await runningSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
      ticket("c"),
    ]);
    const held = (await worker.claim()).body.job as Claimed; // a is under way, c is queued
    expect(await openJobs()).toBe(2);

    const result = await call("POST", `/specs/${specId}/cancel`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      state: "cancelled",
      cancelled: ["T-1", "T-2", "T-3"],
      pullRequests: [],
    });
    expect(await states()).toEqual([
      "1:cancelled",
      "2:cancelled",
      "3:cancelled",
    ]);
    expect(await specState()).toBe("cancelled");
    expect(await openJobs()).toBe(0);
    expect(await cleanups()).toEqual([{ specId }]); // for a worker with the code host; this one has none
    expect((await worker.claim()).body.job).toBeNull();

    // the worker that still holds a's job is told it no longer does, and its result changes nothing
    expect(
      (
        await worker.complete(held.id, held.attempt, {
          stage: "implement",
          ...DONE,
        })
      ).status,
    ).toBe(409);
    expect(await states()).toEqual([
      "1:cancelled",
      "2:cancelled",
      "3:cancelled",
    ]);
    const run = await db.pool.query(
      "SELECT result, finished_at FROM runs WHERE job_id = $1",
      [held.id],
    );
    expect(run.rows[0].result).toBe("cancelled");
    expect(run.rows[0].finished_at).not.toBeNull();
  });

  it("leaves a done ticket as it is", async () => {
    const specId = await runningSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
    ]);
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE id = 1");
    const result = await call("POST", `/specs/${specId}/cancel`);
    expect(result.body.cancelled).toEqual(["T-2"]);
    expect(await states()).toEqual(["1:done", "2:cancelled"]);
  });

  it("works for a draft spec too", async () => {
    const created = await call("POST", "/projects", { name: "shop" });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "git@x:backend",
      role: "backend",
    });
    const draft = await call("POST", "/specs", {
      projectId: created.body.id,
      type: "feature",
      slug: "d",
      title: "Draft",
    });
    expect((await call("POST", `/specs/${draft.body.id}/cancel`)).status).toBe(
      200,
    );
    expect(await specState()).toBe("cancelled");
  });

  it("refuses a spec that is merged or already cancelled, and an unknown one", async () => {
    const specId = await runningSpec([ticket("a")]);
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(200);
    const again = await call("POST", `/specs/${specId}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/not allowed in cancelled/);
    await db.pool.query("UPDATE specs SET state = 'merged'");
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(409);
    expect((await call("POST", "/specs/99/cancel")).status).toBe(404);
  });

  it("no longer lists its tickets or blocked finalizations among what waits for a person", async () => {
    const specId = await runningSpec([ticket("a"), ticket("b")]);
    await stage("implement", GAVE_UP);
    expect((await call("GET", "/blocked")).body.tickets).toHaveLength(1);
    await call("POST", `/specs/${specId}/cancel`);
    const blocked = (await call("GET", "/blocked")).body;
    expect(blocked.tickets).toEqual([]);
    expect(blocked.specs).toEqual([]);
  });
});

describe("cancelling a spec in its overall review", () => {
  it("takes its blocked finalizations off the list of what waits for a person", async () => {
    const specId = await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE id = 1");
    await db.pool.query("UPDATE specs SET state = 'finalizing'");
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id, step, state, blocked_reason) VALUES ($1, 1, 'final-review', 'blocked', 'job-failed')",
      [specId],
    );
    expect((await call("GET", "/blocked")).body.finalizations).toHaveLength(1);
    expect((await call("POST", `/specs/${specId}/cancel`)).status).toBe(200);
    expect((await call("GET", "/blocked")).body.finalizations).toEqual([]);
  });

  it("shows its unfinished overall review as cancelled, and a finished one as it was", async () => {
    const specId = await runningSpec([ticket("a")]);
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE id = 1");
    await db.pool.query("UPDATE specs SET state = 'finalizing'");
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id, step, state, blocked_reason) VALUES ($1, 1, 'final-review', 'blocked', 'job-failed')",
      [specId],
    );
    await call("POST", `/specs/${specId}/cancel`);
    const view = (await call("GET", `/specs/${specId}`)).body;
    expect(view.finalizations).toMatchObject([
      {
        step: "final-review",
        state: "cancelled",
        blockedReason: null,
        brief: null,
      },
    ]);
    await db.pool.query(
      "UPDATE finalizations SET state = 'done', blocked_reason = NULL",
    );
    const done = (await call("GET", `/specs/${specId}`)).body;
    expect(done.finalizations[0].state).toBe("done");
  });
});

describe("a spec whose tickets are all cancelled", () => {
  const specState = async () =>
    (await db.pool.query("SELECT state FROM specs")).rows[0].state;

  it("is cancelled itself, instead of staying running for ever", async () => {
    await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    expect(await specState()).toBe("running");
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await specState()).toBe("cancelled");
    // it made branches like any other spec: they are cleaned up too
    expect(
      (
        await db.pool.query(
          "SELECT payload FROM jobs WHERE type = 'spec-cleanup' AND state = 'queued'",
        )
      ).rows.map((r) => r.payload),
    ).toEqual([{ specId: 1 }]);
  });

  it("is cancelled when the last of several tickets is cancelled", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", GAVE_UP);
    await call("POST", "/tickets/1/cancel", { cascade: false });
    expect(await specState()).toBe("running"); // b waits blocked (upstream-cancelled)
    await call("POST", "/tickets/2/cancel", { cascade: false });
    expect(await specState()).toBe("cancelled");
  });

  it("goes on to its overall review when some of its tickets are done", async () => {
    await runningSpec([ticket("a"), ticket("b")]);
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE id = 1");
    await db.pool.query(
      "UPDATE jobs SET state = 'done' WHERE (payload->>'ticketId')::int = 1",
    );
    await stage("implement", GAVE_UP); // b
    await call("POST", "/tickets/2/cancel", { cascade: false });
    expect(await specState()).toBe("finalizing");
  });
});

describe("resuming a paused spec", () => {
  async function pausedSpec() {
    const specId = await runningSpec([ticket("a"), ticket("b")]);
    await stage("implement", GAVE_UP);
    await stage("implement", GAVE_UP);
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, duration_ms) VALUES ($1, 1, 'implement', $2)",
      [specId, 12 * 3600 * 1000],
    );
    await call("POST", "/tickets/2/retry", { mode: "continue" }); // the scheduler pauses the spec
    expect((await db.pool.query("SELECT state FROM specs")).rows[0].state).toBe(
      "paused",
    );
    return specId;
  }

  it("goes on with the extra agent time it was given, and the waiting ticket starts", async () => {
    const specId = await pausedSpec();
    const result = await call("POST", `/specs/${specId}/resume`, {
      extraSeconds: 3600,
    });
    expect(result).toMatchObject({ status: 200, body: { state: "running" } });
    const spec = await db.pool.query(
      "SELECT state, pause_reason, budget_extra_seconds FROM specs",
    );
    expect(spec.rows[0]).toEqual({
      state: "running",
      pause_reason: null,
      budget_extra_seconds: 3600,
    });
    expect((await states())[1]).toBe("2:queued"); // the retried ticket was waiting for exactly this
    expect((await call("GET", "/blocked")).body.specs).toEqual([]);
  });

  it("pauses again straight away when the extra time is not enough", async () => {
    const specId = await pausedSpec();
    await db.pool.query("UPDATE runs SET duration_ms = $1", [13 * 3600 * 1000]); // an hour over, plus
    // the extra hour does not cover what was used over the limit
    const result = await call("POST", `/specs/${specId}/resume`, {
      extraSeconds: 60,
    });
    expect(result.body.state).toBe("paused");
  });

  it("only a paused spec can be resumed", async () => {
    const specId = await runningSpec([ticket("a")]);
    expect(
      (await call("POST", `/specs/${specId}/resume`, { extraSeconds: 60 }))
        .status,
    ).toBe(409);
    expect(
      (await call("POST", "/specs/99/resume", { extraSeconds: 60 })).status,
    ).toBe(404);
    expect(
      (await call("POST", `/specs/${specId}/resume`, { extraSeconds: 0 }))
        .status,
    ).toBe(400);
  });
});

describe("the spec list", () => {
  it("lists specs newest first with the progress of their tickets", async () => {
    await runningSpec([
      ticket("a"),
      ticket("b", { blocked_by: ["a"] }),
      ticket("c"),
    ]);
    await stage("implement", GAVE_UP); // a: blocked
    await stage("implement", DONE); // c: running
    const created = await call("POST", "/projects", { name: "other" });
    await call("POST", "/specs", {
      projectId: created.body.id,
      type: "bug",
      slug: "second",
      title: "Second",
    });
    const list = await call("GET", "/specs");
    expect(list.status).toBe(200);
    expect(
      list.body.specs.map(
        (s: Json) => `${s.displayId}:${s.state}:${s.project}`,
      ),
    ).toEqual(["S-2:draft:other", "S-1:running:shop"]);
    expect(list.body.specs[0].progress).toEqual({
      total: 0,
      done: 0,
      active: 0,
      blocked: 0,
      pending: 0,
      cancelled: 0,
    });
    expect(list.body.specs[1]).toMatchObject({
      title: "Spec",
      slug: "s",
      type: "feature",
      pauseReason: null,
    });
    expect(list.body.specs[1].progress).toEqual({
      total: 3,
      done: 0,
      active: 1,
      blocked: 1,
      pending: 1,
      cancelled: 0,
    });
    expect(list.body.specs[1].repos).toEqual([
      { name: "backend", url: "git@x:backend", hostKind: "github" },
    ]);
    expect(list.body.specs[0].repos).toEqual([]);
    expect(list.body.specs[0].startedAt).toEqual(expect.any(String));
    expect(list.body.specs[0].endedAt).toBeNull();
    expect(list.body.specs[1].startedAt).toEqual(expect.any(String));
    expect(list.body.specs[1].endedAt).toBeNull();
  });

  it("sets endedAt from the last merged pull request once the spec is merged", async () => {
    const specId = await runningSpec([ticket("a")]);
    const started = (await call("GET", "/specs")).body.specs[0].startedAt;
    expect(started).toEqual(expect.any(String));
    expect((await call("GET", "/specs")).body.specs[0].endedAt).toBeNull();
    const ended = new Date("2026-11-01T10:00:00.000Z");
    await db.pool.query("UPDATE specs SET state = 'merged' WHERE id = $1", [
      specId,
    ]);
    await db.pool.query(
      `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha, synced_at)
       VALUES ($1, 1, 1, 'https://git.example/pr/1', 'merged', 'aaa', $2)`,
      [specId, ended],
    );
    const merged = (await call("GET", "/specs")).body.specs[0];
    expect(merged.startedAt).toBe(started);
    expect(merged.endedAt).toBe(ended.toISOString());
  });

  it("is empty before anything exists", async () => {
    expect((await call("GET", "/specs")).body).toEqual({ specs: [] });
  });
});

describe("what a person sees", () => {
  it("lists blocked tickets with a brief, and paused specs with the reason", async () => {
    const specId = await runningSpec([ticket("a"), ticket("b")]);
    await stage("implement", GAVE_UP);
    await stage("implement", GAVE_UP);
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, duration_ms) VALUES ($1, 1, 'implement', $2)",
      [specId, 12 * 3600 * 1000],
    );
    // retrying b makes the scheduler look at the spec again, and the spec has used up its agent time
    await call("POST", "/tickets/2/retry", { mode: "continue" });
    const queue = await call("GET", "/blocked");
    expect(queue.status).toBe(200);
    expect(
      queue.body.tickets.map((t: Json) => `${t.displayId}:${t.state}`),
    ).toEqual(["T-1:blocked"]);
    expect(queue.body.tickets[0]).toMatchObject({
      displayId: "T-1",
      specDisplayId: "S-1",
      state: "blocked",
      blockedReason: "agent-gave-up",
      repo: "backend",
      brief: {
        stage: "implement",
        result: "agent-gave-up",
        output: { detail: "needs a decision" },
      },
    });
    expect(queue.body.tickets[0].brief.logPath).toMatch(/^\/runs\/\d+\/logs$/);
    expect(queue.body.specs).toEqual([
      {
        id: specId,
        displayId: "S-1",
        title: "Spec",
        reason: "the agent time limit of the spec was reached",
      },
    ]);
  });

  it("is empty when nothing waits", async () => {
    await runningSpec([ticket("a")]);
    expect((await call("GET", "/blocked")).body).toEqual({
      tickets: [],
      finalizations: [],
      pullRequests: [],
      cleanups: [],
      readyFailures: [],
      planning: [],
      specs: [],
    });
  });

  it("shows a ticket with its runs, findings, gate results and neighbours", async () => {
    await runningSpec([ticket("a"), ticket("b", { blocked_by: ["a"] })]);
    await stage("implement", {
      outcome: "done",
      run: {
        headSha: "abc",
        branch: "agent/T-1",
        agent: "cursor",
        model: "auto",
        skillsSha: "5beb35b",
        cursorCliVersion: "1.2.3",
        durationMs: 146000,
      },
    });
    await stage("gate", {
      outcome: "passed",
      run: { headSha: "abc" },
      gate: {
        commitSha: "abc",
        configSha: "cfg",
        commandResults: [{ name: "test", exitCode: 0 }],
        testsTotal: 5,
        testsSkipped: 0,
      },
    });
    await stage("review", {
      outcome: "pass",
      findings: [{ kind: "suggestion", body: "rename x" }],
    });
    const view = await call("GET", "/tickets/1");
    expect(view.status).toBe(200);
    expect(view.body.ticket).toMatchObject({
      displayId: "T-1",
      state: "merging",
      acceptanceCriteria: ["it works"],
      reviewed: true,
      brief: null,
      repo: "backend",
      repoUrl: "git@x:backend",
      hostKind: "github",
    });
    expect(view.body.downstream).toEqual([
      { id: 2, displayId: "T-2", kind: "blocks", state: "pending" },
    ]);
    expect(view.body.upstream).toEqual([]);
    expect(
      view.body.runs.map((r: Json) => `${r.displayId}:${r.stage}:${r.result}`),
    ).toEqual(["R-1:implement:done", "R-2:gate:passed", "R-3:review:pass"]);
    expect(view.body.runs[0]).toMatchObject({
      agent: "cursor",
      model: "auto",
      skillsSha: "5beb35b",
      cursorCliVersion: "1.2.3",
      durationMs: 146000,
    });
    expect(view.body.runs[1]).toMatchObject({ model: null, skillsSha: null }); // a gate run has no model
    expect(view.body.findings).toEqual([
      {
        id: 1,
        runId: 3,
        kind: "suggestion",
        body: "rename x",
        resolution: "acceptance-pack",
        axis: null,
      },
    ]);
    expect(view.body.gateResults).toEqual([
      {
        kind: "gate",
        commitSha: "abc",
        configSha: "cfg",
        commandResults: [{ name: "test", exitCode: 0 }],
        testsTotal: 5,
        testsSkipped: 0,
      },
    ]);
    expect((await call("GET", "/tickets/2")).body.upstream).toEqual([
      { id: 1, displayId: "T-1", kind: "blocks", state: "merging" },
    ]);
    expect((await call("GET", "/tickets/99")).status).toBe(404);
  });

  it("shows a spec with its tickets, edges, integration branch and import warnings", async () => {
    const specId = await runningSpec([
      ticket("a", { modules: ["src/x/**"] }),
      ticket("b", { modules: ["src/x/y.ts"] }),
      ticket("c", { blocked_by: ["a"] }),
    ]);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.status).toBe(200);
    expect(view.body.spec).toMatchObject({
      displayId: "S-1",
      slug: "s",
      state: "running",
      pauseReason: null,
    });
    const id = (await db.pool.query("SELECT id FROM instance")).rows[0].id;
    expect(view.body.spec.integrationBranches).toEqual([
      {
        repoId: 1,
        branch: `spec/${id}/s`,
        name: "backend",
        url: "git@x:backend",
        hostKind: "github",
      },
    ]);
    expect(view.body.spec.repos).toEqual([
      { name: "backend", url: "git@x:backend", hostKind: "github" },
    ]);
    expect(view.body.spec.warnings).toHaveLength(1); // a and b overlap without a path between them
    expect(
      view.body.tickets.map((t: Json) => `${t.displayId}:${t.state}`),
    ).toEqual(["T-1:queued", "T-2:queued", "T-3:pending"]);
    expect(view.body.edges).toEqual([
      { from: "T-1", to: "T-3", kind: "blocks" },
    ]);
    expect((await call("GET", "/specs/99")).status).toBe(404);
  });

  it("reconstructs the listed timeline events and finishing runs", async () => {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", DONE);
    await stage("gate", {
      outcome: "passed",
      run: { headSha: "abc" },
      gate: {
        commitSha: "abc",
        configSha: "cfg",
        commandResults: [{ name: "test", exitCode: 0 }],
        testsTotal: 1,
        testsSkipped: 0,
      },
    });
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, axis, result, duration_ms, started_at, finished_at)
       VALUES ($1, 1, 'final-review', 'standards', 'passed', 90000, now() - interval '90 seconds', now())`,
      [specId],
    );
    const view = await call("GET", `/specs/${specId}`);
    expect(view.status).toBe(200);
    expect(view.body.timeline.map((e: Json) => e.kind)).toEqual([
      "confirm-plan",
      "ticket-start",
      "gate",
      "finalization",
    ]);
    expect(view.body.timeline[2]).toMatchObject({
      kind: "gate",
      text: "T-1 门禁通过",
    });
    expect(view.body.finalRuns).toEqual([
      {
        id: expect.any(Number),
        displayId: expect.stringMatching(/^R-\d+$/),
        repo: "backend",
        stage: "final-review",
        axis: "standards",
        result: "passed",
        durationMs: 90000,
        startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        finishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ]);
  });

  it("a spec view carries the brief of every blocked ticket", async () => {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", GAVE_UP);
    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.tickets[0].brief).toMatchObject({
      stage: "implement",
      result: "agent-gave-up",
    });
  });

  it("shows one run by itself, including a finishing run with no ticket", async () => {
    const specId = await runningSpec([ticket("a")]);
    await stage("implement", {
      outcome: "done",
      run: {
        durationMs: 146000,
        prompt: "overlay + implement",
        output: { outcome: "done" },
        commits: ["abc1234"],
      },
    });
    const ticketRun = await call("GET", "/runs/1");
    expect(ticketRun.status).toBe(200);
    expect(ticketRun.body).toMatchObject({
      id: 1,
      displayId: "R-1",
      specId,
      specDisplayId: "S-1",
      ticketId: 1,
      ticketDisplayId: "T-1",
      stage: "implement",
      attempt: 1,
      result: "done",
      durationMs: 146000,
      prompt: "overlay + implement",
      output: { outcome: "done" },
      commits: ["abc1234"],
    });
    const listed = await call("GET", "/tickets/1");
    expect(listed.body.runs[0].prompt).toBeUndefined();
    expect(listed.body.runs[0].output).toBeUndefined();
    expect(listed.body.runs[0].commits).toBeUndefined();
    await db.pool.query(
      `INSERT INTO runs (spec_id, repo_id, stage, result)
       VALUES ($1, 1, 'final-review', 'passed')`,
      [specId],
    );
    const finishing = await call("GET", "/runs/2");
    expect(finishing.status).toBe(200);
    expect(finishing.body).toMatchObject({
      displayId: "R-2",
      specId,
      ticketId: null,
      ticketDisplayId: null,
      stage: "final-review",
      result: "passed",
      prompt: null,
      output: null,
      commits: [],
    });
    expect((await call("GET", "/runs/99")).status).toBe(404);
  });
});

describe("search", () => {
  async function twoSpecs() {
    await runningSpec([
      ticket("export", {
        title: "Export orders as CSV",
        body: "Customers want a Spreadsheet download.",
      }),
      ticket("pay", { title: "Payment retries" }),
    ]);
    const created = await call("POST", "/projects", { name: "other" });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "git@x:b",
      role: "backend",
    });
    const second = await call("POST", "/specs", {
      projectId: created.body.id,
      type: "bug",
      slug: "refund",
      title: "Refund bug",
      body: "Refunds over 100% are rejected.",
    });
    await call(
      "POST",
      `/specs/${second.body.id}/tickets/import`,
      importBody(second.body.id, {
        tickets: [ticket("refund", { title: "Fix the refund_total rounding" })],
      }),
    );
  }
  const find = async (q: string) =>
    (await call("GET", `/search?q=${encodeURIComponent(q)}`)).body as Json;
  const names = (list: Json[]) => list.map((x) => x.displayId);

  it("finds a spec or a ticket by its number, ignoring case", async () => {
    await twoSpecs();
    expect(names((await find("S-2")).specs)).toEqual(["S-2"]);
    expect(names((await find("s-1")).specs)).toEqual(["S-1"]);
    expect(names((await find("t-3")).tickets)).toEqual(["T-3"]);
    expect((await find("T-3")).tickets[0].matched).toEqual(["id"]);
  });

  it("finds by title, ignoring case, in the middle of a word", async () => {
    await twoSpecs();
    const result = await find("ORDERS as csv");
    expect(names(result.tickets)).toEqual(["T-1"]);
    expect(result.tickets[0]).toMatchObject({
      title: "Export orders as CSV",
      specDisplayId: "S-1",
      matched: ["title"],
    });
    expect(names((await find("rfund bug")).specs)).toEqual([]); // a substring, not a fuzzy match
    expect(names((await find("ref")).specs)).toEqual(["S-2"]);
  });

  it("finds by body, and says where the text was found", async () => {
    await twoSpecs();
    const result = await find("spreadsheet");
    expect(names(result.tickets)).toEqual(["T-1"]);
    expect(result.tickets[0].matched).toEqual(["body"]);
    expect(names((await find("rejected")).specs)).toEqual(["S-2"]);
  });

  it("groups specs and tickets, newest first", async () => {
    await twoSpecs();
    const result = await find("refund");
    expect(names(result.specs)).toEqual(["S-2"]);
    expect(names(result.tickets)).toEqual(["T-3"]);
    const both = await find("e"); // matches nearly everything
    expect(names(both.tickets)).toEqual(
      [...names(both.tickets)].sort(
        (a, b) => Number(b.slice(2)) - Number(a.slice(2)),
      ),
    );
  });

  it("takes % and _ and backslash as the characters they are, not as wildcards", async () => {
    await twoSpecs();
    expect(names((await find("100%")).specs)).toEqual(["S-2"]);
    expect(names((await find("%")).specs)).toEqual(["S-2"]); // only the body that has a percent sign
    expect(names((await find("refund_total")).tickets)).toEqual(["T-3"]);
    expect((await find("refund_total")).tickets).toHaveLength(1);
    expect(names((await find("refund-total")).tickets)).toEqual([]); // _ is not "any character"
    expect(names((await find("\\")).tickets)).toEqual([]);
  });

  it("returns empty lists for no match", async () => {
    await twoSpecs();
    expect(await find("zzz-no-such-thing")).toEqual({ specs: [], tickets: [] });
  });

  it("refuses an empty search and an enormous one", async () => {
    expect((await call("GET", "/search?q=")).status).toBe(400);
    expect((await call("GET", "/search?q=%20%20")).status).toBe(400);
    expect((await call("GET", "/search")).status).toBe(400);
    expect((await call("GET", `/search?q=${"a".repeat(201)}`)).status).toBe(
      400,
    );
  });

  it("caps the number of results per kind", async () => {
    const created = await call("POST", "/projects", { name: "many" });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: "git@x:b",
      role: "backend",
    });
    for (let i = 0; i < 55; i++) {
      await db.pool.query(
        "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', $2, 'Needle')",
        [created.body.id, `s${i}`],
      );
    }
    const result = await find("needle");
    expect(result.specs).toHaveLength(50);
    expect(result.specs[0].displayId).toBe("S-55"); // the newest
  });
});
