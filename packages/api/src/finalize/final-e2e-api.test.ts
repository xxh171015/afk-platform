import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

// Before the pull requests are opened, each integration ticket runs its e2e once more when a repo's final fix
// changed its branch (docs/specs/m2-platform.md「收尾、PR 与合并」).

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(testApp({ pool: db.pool }));
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

const CRITERION = "the export button downloads a file";

// T-1 in the backend, T-2 the integration ticket in the frontend, which uses the backend's services.
async function runningSpec(withIntegration = true) {
  const created = await call("POST", "/projects", { name: "shop" });
  for (const name of ["backend", "frontend"])
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "export",
    title: "Export orders",
  });
  const imported = await call(
    "POST",
    `/specs/${spec.body.id}/tickets/import`,
    importBody(spec.body.id, {
      tickets: [
        {
          key: "be",
          repo: "backend",
          type: "implementation",
          title: "Export endpoint",
          modules: ["src/export/**"],
          acceptance: ["it exports"],
        },
        ...(withIntegration
          ? [
              {
                key: "e2e",
                repo: "frontend",
                type: "integration",
                title: "Export e2e",
                modules: ["e2e/**"],
                acceptance: [CRITERION],
                environment: ["backend"],
                blocked_by: ["be"],
              },
            ]
          : []),
      ],
    }),
  );
  expect(imported.status).toBe(200);
  await call("POST", `/specs/${spec.body.id}/confirm`);
}

interface Claimed {
  id: number;
  type: string;
  attempt: number;
  payload: {
    stage: string;
    ticketId?: number;
    repoId?: number;
    final?: boolean;
    finalE2e?: boolean;
    round?: number;
  };
}

const REVIEW_PASS = {
  verdict: "pass",
  mustFix: [],
  suggestions: [],
  uncertainties: [],
};
const REVIEW_FIX = { ...REVIEW_PASS, verdict: "fix" };

const e2eRun = (result: "passed" | "failed", sha: string, extra = {}) => ({
  outcome: result,
  run: {
    headSha: sha,
    refShas: { backend: `be-${sha}` },
    testsTotal: 2,
    testsFailed: result === "failed" ? 1 : 0,
    envUpMs: 4000,
    ...extra,
  },
  gate: {
    kind: "e2e",
    commitSha: sha,
    configSha: "cfg",
    testsTotal: 2,
    testsSkipped: 0,
    testCases: [
      { name: "downloads the export", classname: "e2e", status: "passed" },
      {
        name: "shows the button",
        classname: "e2e",
        status: result === "passed" ? "passed" : "failed",
      },
    ],
  },
});

const DIAGNOSIS = {
  outcome: "diagnosed",
  diagnosis: {
    failingRepo: "backend",
    evidence: "GET /orders/export answers 404",
    failingTests: ["shows the button"],
  },
  run: {
    output: {
      result: "fail",
      failingRepo: "backend",
      evidence: "GET /orders/export answers 404",
      failingTests: ["shows the button"],
    },
  },
};

async function skipHostSync(job: Claimed) {
  if (job.type !== "host-sync") return false;
  await worker.complete(job.id, job.attempt, {
    stage: "host-sync",
    pulls: [],
  });
  return true;
}

async function claimSkippingHostSync() {
  for (let i = 0; i < 8; i++) {
    const job = (await worker.claim()).body.job as Claimed | null;
    if (!job) return null;
    if (await skipHostSync(job)) continue;
    return job;
  }
  return null;
}

// What the worker answers to each job; undefined asks the test to look at the job first (it stays running).
interface Plan {
  // the final-review of a repo, in order of the repos' ids (backend 1, frontend 2)
  review?: Record<number, Record<string, unknown>>;
  // the e2e and the diagnosis of the final-e2e step, one answer for each time the stage is claimed
  finalE2e?: Record<string, Record<string, unknown>[]>;
}

// Works jobs until there are none, or a pull request is to be opened, or a job of the final-e2e step is claimed
// with nothing planned for it (that one is handed back through `held`).
async function drive(plan: Plan = {}) {
  const e2eAnswers = { e2e: [] as Json[], diagnose: [] as Json[] };
  for (const [stage, list] of Object.entries(plan.finalE2e ?? {}))
    e2eAnswers[stage as "e2e" | "diagnose"] = [...list];
  const seen: Claimed[] = [];
  for (let i = 0; i < 80; i++) {
    const waiting = await db.pool.query(
      "SELECT 1 FROM jobs WHERE type = 'open-pr' AND state = 'queued'",
    );
    if (waiting.rowCount) break;
    const job = (await worker.claim()).body.job as Claimed | null;
    if (!job) break;
    if (await skipHostSync(job)) continue;
    seen.push(job);
    const { stage } = job.payload;
    let result: Record<string, unknown>;
    if (job.payload.finalE2e) {
      const next = e2eAnswers[stage as "e2e" | "diagnose"].shift();
      if (!next) throw new Error(`nothing planned for the final ${stage}`);
      result = next;
    } else if (stage === "final-review") {
      const repoId = job.payload.repoId as number;
      const planned = plan.review?.[repoId];
      result = planned ?? { outcome: "pass", run: { output: REVIEW_PASS } };
    } else if (stage === "final-fix") {
      result = { outcome: "done" };
    } else if (stage === "final-merge") {
      result = { outcome: "merged", headSha: "final-head" };
    } else if (stage === "e2e") {
      result = e2eRun("passed", "fe-head");
    } else if (stage === "implement") {
      result = {
        outcome: "done",
        run: {
          output: {
            status: "done",
            acceptance: { [CRITERION]: ["downloads the export"] },
            uncertainties: [],
          },
        },
      };
    } else {
      result = {
        gate: { outcome: "passed" },
        review: { outcome: "pass" },
        merge: { outcome: "merged", headSha: "head" },
      }[stage as "gate" | "review" | "merge"] as Record<string, unknown>;
    }
    const reply = await worker.complete(job.id, job.attempt, {
      stage,
      ...result,
    });
    expect(reply.status).toBe(200);
  }
  return seen;
}

const FIX_BACKEND = { 1: { outcome: "fix", run: { output: REVIEW_FIX } } };

// Completes every job until the first job of the final-e2e step, which is left running.
async function completeUntilFinalE2e(): Promise<Claimed> {
  for (let i = 0; i < 60; i++) {
    const job = await claimSkippingHostSync();
    if (!job) break;
    if (job.payload.finalE2e) return job;
    const stage = job.payload.stage;
    const result =
      stage === "final-review"
        ? job.payload.repoId === 1
          ? { outcome: "fix", run: { output: REVIEW_FIX } }
          : { outcome: "pass", run: { output: REVIEW_PASS } }
        : stage === "final-fix"
          ? { outcome: "done" }
          : stage === "final-merge"
            ? { outcome: "merged", headSha: "h" }
            : stage === "e2e"
              ? e2eRun("passed", "fe-head")
              : stage === "gate"
                ? { outcome: "passed" }
                : stage === "review"
                  ? { outcome: "pass" }
                  : stage === "implement"
                    ? { outcome: "done" }
                    : { outcome: "merged", headSha: "head" };
    await worker.complete(job.id, job.attempt, { stage, ...result });
  }
  throw new Error("no final e2e job");
}

const finalE2e = async () =>
  (
    await db.pool.query(
      "SELECT state, blocked_reason, round, tickets FROM final_e2e",
    )
  ).rows[0] as Json | undefined;
const queuedOf = async (type: string) =>
  (
    await db.pool.query("SELECT payload FROM jobs WHERE type = $1", [type])
  ).rows.map((r) => r.payload) as Json[];
const specState = async () =>
  (await db.pool.query("SELECT state FROM specs")).rows[0].state as string;

describe("the e2e before the pull requests", () => {
  it("does not run when no repo had a final fix", async () => {
    await runningSpec();
    const seen = await drive();
    expect(seen.some((j) => j.payload.finalE2e)).toBe(false);
    expect(await finalE2e()).toBeUndefined();
    expect(await queuedOf("open-pr")).toHaveLength(2);
  });

  it("does not run when the spec has no integration ticket", async () => {
    await runningSpec(false);
    await drive({ review: FIX_BACKEND });
    expect(await finalE2e()).toBeUndefined();
    expect(await queuedOf("open-pr")).toHaveLength(1);
  });

  it("runs once for each integration ticket after the repos' finalizations, before any pull request is opened", async () => {
    await runningSpec();
    // the backend's final review wants a fix; the frontend's passes
    const seen = await drive({
      review: FIX_BACKEND,
      finalE2e: { e2e: [e2eRun("passed", "fe-final")] },
    });
    const e2e = seen.filter((j) => j.payload.finalE2e);
    expect(e2e.map((j) => j.payload.stage)).toEqual(["e2e"]);
    expect(e2e[0]?.type).toBe("e2e");
    expect(e2e[0]?.payload.ticketId).toBe(2);
    // it came after every final step of both repos
    expect(seen.indexOf(e2e[0] as Claimed)).toBe(seen.length - 1);
    expect(await finalE2e()).toMatchObject({ state: "done" });
    expect(await queuedOf("open-pr")).toHaveLength(2);
  });

  it("does not open a pull request while it is running", async () => {
    await runningSpec();
    const held = [] as Claimed[];
    for (let i = 0; i < 40 && held.length === 0; i++) {
      const job = await claimSkippingHostSync();
      if (!job) break;
      if (job.payload.finalE2e) {
        held.push(job);
        break;
      }
      const stage = job.payload.stage;
      const result =
        stage === "final-review"
          ? job.payload.repoId === 1
            ? { outcome: "fix", run: { output: REVIEW_FIX } }
            : { outcome: "pass", run: { output: REVIEW_PASS } }
          : stage === "final-fix"
            ? { outcome: "done" }
            : stage === "final-merge"
              ? { outcome: "merged", headSha: "h" }
              : stage === "e2e"
                ? e2eRun("passed", "fe-head")
                : stage === "implement"
                  ? { outcome: "done" }
                  : stage === "gate"
                    ? { outcome: "passed" }
                    : stage === "review"
                      ? { outcome: "pass" }
                      : { outcome: "merged", headSha: "head" };
      await worker.complete(job.id, job.attempt, { stage, ...result });
    }
    expect(held).toHaveLength(1);
    expect(await specState()).toBe("finalizing");
    expect(await queuedOf("open-pr")).toHaveLength(0);
    expect(await finalE2e()).toMatchObject({ state: "active", round: 1 });
  });
});

describe("a failed e2e before the pull requests", () => {
  async function failed() {
    await runningSpec();
    await drive({
      review: FIX_BACKEND,
      finalE2e: {
        e2e: [e2eRun("failed", "fe-final")],
        diagnose: [DIAGNOSIS],
      },
    });
  }

  it("is diagnosed for the evidence only, and blocks the finalization without a fix ticket", async () => {
    await failed();
    expect(await finalE2e()).toMatchObject({
      state: "blocked",
      blocked_reason: "final-e2e-failed",
    });
    expect(await specState()).toBe("finalizing");
    expect(await queuedOf("open-pr")).toHaveLength(0);
    // no fix ticket: the diagnosis is only for the brief
    expect(
      (await db.pool.query("SELECT id FROM tickets WHERE type = 'fix'")).rows,
    ).toHaveLength(0);
    const blocked = (await call("GET", "/blocked")).body;
    const entry = blocked.finalizations.find(
      (f: Json) => f.step === "final-e2e",
    );
    expect(entry).toMatchObject({
      blockedReason: "final-e2e-failed",
      failureSource: "agent",
      state: "blocked",
    });
    expect(JSON.stringify(entry.brief.output)).toContain("answers 404");
  });

  it("runs the e2e again when a person retries, and opens the pull requests when it passes", async () => {
    await failed();
    const retried = await call("POST", "/specs/1/final/retry");
    expect(retried.status).toBe(200);
    expect(retried.body.retried).toContain("final-e2e");
    expect(await finalE2e()).toMatchObject({ state: "active", round: 2 });
    await drive({ finalE2e: { e2e: [e2eRun("passed", "fe-final")] } });
    expect(await finalE2e()).toMatchObject({ state: "done", round: 2 });
    expect(await queuedOf("open-pr")).toHaveLength(2);
  });

  it("still blocks when the retry fails, and a result of the earlier round changes nothing", async () => {
    await failed();
    await call("POST", "/specs/1/final/retry");
    await drive({
      finalE2e: { e2e: [e2eRun("failed", "fe-final")], diagnose: [DIAGNOSIS] },
    });
    expect(await finalE2e()).toMatchObject({ state: "blocked", round: 2 });
  });

  it("opens the pull requests when a person lets it through, and the acceptance pack says the e2e failed", async () => {
    await failed();
    const waived = await call("POST", "/specs/1/final/waive");
    expect(waived.status).toBe(200);
    expect(
      (
        await db.pool.query(
          "SELECT source, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows.at(-1),
    ).toEqual({ source: "page", action: "waive-final" });
    expect(await finalE2e()).toMatchObject({ state: "waived" });
    expect(await queuedOf("open-pr")).toHaveLength(2);

    for (const repoId of [1, 2]) {
      const job = (await claimSkippingHostSync()) as Claimed;
      expect(job.type).toBe("open-pr");
      await worker.complete(job.id, job.attempt, {
        stage: "open-pr",
        outcome: "opened",
        number: repoId,
        url: `https://github.com/me/x/pull/${repoId}`,
        state: "open",
        draft: false,
        headSha: `sha${repoId}`,
        ci: "none",
        review: "none",
      });
    }
    const pack = (await call("GET", "/specs/1")).body.acceptancePack;
    expect(pack.integration.failedBeforePullRequest).toMatchObject({
      tickets: [
        expect.objectContaining({
          displayId: "T-2",
          diagnosis: expect.objectContaining({
            failingRepo: "backend",
            evidence: expect.stringContaining("answers 404"),
          }),
        }),
      ],
    });
  });

  it("can be waived or retried only while it is blocked", async () => {
    await runningSpec();
    expect((await call("POST", "/specs/1/final/waive")).status).toBe(409);
    await drive({
      review: FIX_BACKEND,
      finalE2e: { e2e: [e2eRun("passed", "fe-final")] },
    });
    expect((await call("POST", "/specs/1/final/waive")).status).toBe(409);
    expect((await call("POST", "/specs/99/final/waive")).status).toBe(404);
  });

  it("cannot be let through once the spec is cancelled", async () => {
    await failed();
    expect((await call("POST", "/specs/1/cancel")).status).toBe(200);
    expect((await call("POST", "/specs/1/final/waive")).status).toBe(409);
    expect(await queuedOf("open-pr")).toHaveLength(0);
  });

  it("blocks at once with sandbox-oom when the container was OOMKilled, as a platform problem", async () => {
    await runningSpec();
    const job = await completeUntilFinalE2e();
    const failedReply = await worker.fail(
      job.id,
      job.attempt,
      "sandbox-oom: container OOMKilled",
    );
    expect(failedReply.status).toBe(200);
    expect(await finalE2e()).toMatchObject({
      state: "blocked",
      blocked_reason: "sandbox-oom",
    });
    expect(await claimSkippingHostSync()).toBeNull();
    const blocked = (await call("GET", "/blocked")).body;
    const entry = blocked.finalizations.find(
      (f: Json) => f.step === "final-e2e",
    );
    expect(entry).toMatchObject({
      blockedReason: "sandbox-oom",
      failureSource: "platform",
    });
  });

  it("blocks once on an image that would not build, as an outside service, and does not requeue", async () => {
    await runningSpec();
    const job = await completeUntilFinalE2e();
    const failedReply = await worker.fail(
      job.id,
      job.attempt,
      "docker build of backend (backend) failed (exit 1):\nERROR: failed to solve",
    );
    expect(failedReply.status).toBe(200);
    expect(await finalE2e()).toMatchObject({
      state: "blocked",
      blocked_reason: "job-failed",
    });
    expect(await claimSkippingHostSync()).toBeNull();
    const blocked = (await call("GET", "/blocked")).body;
    const entry = blocked.finalizations.find(
      (f: Json) => f.step === "final-e2e",
    );
    expect(entry).toMatchObject({
      blockedReason: "job-failed",
      failureSource: "external",
      brief: {
        output: {
          error: "联调镜像构建失败，修好 Dockerfile 或基础镜像后再试",
        },
      },
    });
  });

  it("is blocked as integration-environment-failed after three failed jobs", async () => {
    await runningSpec();
    // get to the final e2e job
    const seen: Claimed[] = [];
    for (let i = 0; i < 60; i++) {
      const job = await claimSkippingHostSync();
      if (!job) break;
      if (job.payload.finalE2e) {
        seen.push(job);
        const failedReply = await worker.fail(
          job.id,
          job.attempt,
          "no network",
        );
        expect(failedReply.status).toBe(200);
        if (seen.length === 3) break;
        continue;
      }
      const stage = job.payload.stage;
      const result =
        stage === "final-review"
          ? job.payload.repoId === 1
            ? { outcome: "fix", run: { output: REVIEW_FIX } }
            : { outcome: "pass", run: { output: REVIEW_PASS } }
          : stage === "final-fix"
            ? { outcome: "done" }
            : stage === "final-merge"
              ? { outcome: "merged", headSha: "h" }
              : stage === "e2e"
                ? e2eRun("passed", "fe-head")
                : stage === "gate"
                  ? { outcome: "passed" }
                  : stage === "review"
                    ? { outcome: "pass" }
                    : stage === "implement"
                      ? { outcome: "done" }
                      : { outcome: "merged", headSha: "head" };
      await worker.complete(job.id, job.attempt, { stage, ...result });
    }
    expect(seen).toHaveLength(3);
    expect(await finalE2e()).toMatchObject({
      state: "blocked",
      blocked_reason: "integration-environment-failed",
    });
  });
});

describe("the integration section of the acceptance pack", () => {
  async function packOf(plan: Plan) {
    await runningSpec();
    await drive(plan);
    for (const repoId of [1, 2]) {
      const job = (await claimSkippingHostSync()) as Claimed;
      await worker.complete(job.id, job.attempt, {
        stage: "open-pr",
        outcome: "opened",
        number: repoId,
        url: `https://github.com/me/x/pull/${repoId}`,
        state: "open",
        draft: false,
        headSha: `sha${repoId}`,
        ci: "none",
        review: "none",
      });
    }
    return (await call("GET", "/specs/1")).body.acceptancePack;
  }

  it("shows the result of the last e2e, the SHAs of the repos in the environment, and checks the criteria against it", async () => {
    const pack = await packOf({
      review: FIX_BACKEND,
      finalE2e: { e2e: [e2eRun("passed", "fe-final")] },
    });
    expect(pack.integration.failedBeforePullRequest).toBeNull();
    const [ticket] = pack.integration.tickets;
    expect(ticket).toMatchObject({
      displayId: "T-2",
      repo: "frontend",
      result: "passed",
      testsTotal: 2,
      testsFailed: 0,
      refShas: { backend: "be-fe-final" }, // the rerun's, not the first e2e's
      headSha: "fe-final",
    });
    expect(ticket.criteria).toEqual([
      expect.objectContaining({ text: CRITERION, status: "verified" }),
    ]);
    // the integration ticket is not among the tickets of its repo's section
    const frontend = pack.repos.find((r: Json) => r.repo === "frontend");
    expect(frontend.tickets).toEqual([]);
  });

  it("has none for a spec without integration tickets", async () => {
    await runningSpec(false);
    await drive();
    const job = (await claimSkippingHostSync()) as Claimed;
    await worker.complete(job.id, job.attempt, {
      stage: "open-pr",
      outcome: "opened",
      number: 1,
      url: "https://github.com/me/x/pull/1",
      state: "open",
      draft: false,
      headSha: "sha1",
      ci: "none",
      review: "none",
    });
    const pack = (await call("GET", "/specs/1")).body.acceptancePack;
    expect(pack.integration).toBeNull();
  });
});
