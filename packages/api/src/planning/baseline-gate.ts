import {
  BASELINE_GATE_JOB,
  type BaselineGateState,
  branchNames,
  formatDisplayId,
  specTransition,
} from "@afk/shared";
import type pg from "pg";
import { enqueueHostSync } from "../host/host-jobs.ts";
import { enqueueJob, type Queryable } from "../jobs/queue.ts";
import { rememberGateTestCases } from "../stages/gate-records.ts";
import {
  type IntegrationBranch,
  integrationBranch,
} from "./integration-branches.ts";

export { BASELINE_GATE_JOB };

const SHA_RE = /^[0-9a-f]{40}$/;

export interface BaselineGatePayload {
  specId: number;
  repoId: number;
  sha?: string;
  recut?: boolean;
}

export function readBaselineGatePayload(job: {
  type?: string;
  payload: Record<string, unknown>;
}): BaselineGatePayload | undefined {
  const { specId, repoId, sha, recut } = job.payload;
  if (job.type !== BASELINE_GATE_JOB || typeof specId !== "number")
    return undefined;
  if (typeof repoId !== "number") return undefined;
  return {
    specId,
    repoId,
    ...(typeof sha === "string" && SHA_RE.test(sha) ? { sha } : {}),
    ...(recut === true ? { recut: true } : {}),
  };
}

const keyPrefix = (specId: number, repoId: number) =>
  `${formatDisplayId("spec", specId)}:repo-${repoId}:${BASELINE_GATE_JOB}:`;

export async function isBaselineGatePending(
  client: Queryable,
  specId: number,
): Promise<boolean> {
  const { rows } = await client.query<{ baseline_gate_state: string | null }>(
    "SELECT baseline_gate_state FROM specs WHERE id = $1",
    [specId],
  );
  return rows[0]?.baseline_gate_state === "pending";
}

export type BaselineGateHold = "ready" | "waiting" | "paused";

// After planning is done: enqueue one job per repo that has a cut SHA, wait for those jobs, pause if any
// failed, or let the scheduler start tickets. A spec with no cut SHA yet is ready (host-sync has not named
// the default branch head).
export async function holdForBaselineGate(
  client: pg.PoolClient,
  specId: number,
  options: { recut?: boolean } = {},
): Promise<BaselineGateHold> {
  const spec = await client.query<{
    baseline_gate_state: BaselineGateState | null;
    integration_branches: IntegrationBranch[];
    state: string;
  }>(
    "SELECT baseline_gate_state, integration_branches, state FROM specs WHERE id = $1",
    [specId],
  );
  const row = spec.rows[0];
  if (!row) return "ready";
  if (
    row.baseline_gate_state === "done" ||
    row.baseline_gate_state === "waived"
  )
    return "ready";
  if (row.baseline_gate_state === "pending")
    return settleBaselineJobs(client, specId);
  const branches = row.integration_branches ?? [];
  const cuts = await cutsOf(client, branches);
  if (cuts.length === 0) {
    await client.query(
      "UPDATE specs SET baseline_gate_state = 'done' WHERE id = $1 AND baseline_gate_state IS NULL",
      [specId],
    );
    return "ready";
  }
  await client.query(
    "UPDATE specs SET baseline_gate_state = 'pending' WHERE id = $1 AND baseline_gate_state IS NULL",
    [specId],
  );
  for (const cut of cuts) {
    await enqueueBaselineGate(
      client,
      specId,
      cut.repoId,
      cut.sha,
      options.recut === true,
    );
  }
  return "waiting";
}

async function cutsOf(
  client: Queryable,
  branches: IntegrationBranch[],
): Promise<{ repoId: number; sha: string }[]> {
  if (branches.length === 0) return [];
  const ids = branches.map((branch) => branch.repoId);
  const { rows } = await client.query<{
    id: number;
    default_sha: string | null;
  }>("SELECT id, default_sha FROM repos WHERE id = ANY($1::int[])", [ids]);
  const shaById = new Map(rows.map((row) => [row.id, row.default_sha]));
  const cuts: { repoId: number; sha: string }[] = [];
  for (const branch of branches) {
    const sha = branch.mainSha ?? shaById.get(branch.repoId) ?? undefined;
    if (typeof sha === "string" && SHA_RE.test(sha))
      cuts.push({ repoId: branch.repoId, sha });
  }
  return cuts;
}

async function enqueueBaselineGate(
  client: pg.PoolClient,
  specId: number,
  repoId: number,
  sha: string,
  recut = false,
): Promise<void> {
  const prefix = keyPrefix(specId, repoId);
  const earlier = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE $1",
    [`${prefix}%`],
  );
  await enqueueJob(client, {
    type: BASELINE_GATE_JOB,
    payload: { specId, repoId, sha, ...(recut ? { recut: true } : {}) },
    idempotencyKey: `${prefix}${Number(earlier.rows[0]?.n) + 1}`,
  });
}

export async function baselineGateTask(
  pool: Queryable,
  payload: BaselineGatePayload,
) {
  const repo = (
    await pool.query<{
      name: string;
      url: string;
      default_branch: string;
    }>("SELECT name, url, default_branch FROM repos WHERE id = $1", [
      payload.repoId,
    ])
  ).rows[0];
  if (!repo) return undefined;
  const task = {
    repo: {
      name: repo.name,
      url: repo.url,
      defaultBranch: repo.default_branch,
    },
    sha: payload.sha,
    specId: payload.specId,
  };
  if (!payload.recut) return task;
  const spec = (
    await pool.query<{
      slug: string;
      branch_namespace: string | null;
      planning_repo_id: number | null;
      planning_sha: string | null;
      planning_state: string | null;
      planning_docs_committed: boolean;
      integration_branches: IntegrationBranch[];
    }>(
      `SELECT slug, branch_namespace, planning_repo_id, planning_sha, planning_state,
              planning_docs_committed, integration_branches
       FROM specs WHERE id = $1`,
      [payload.specId],
    )
  ).rows[0];
  if (!spec) return task;
  const named = spec.integration_branches.find(
    (branch) => branch.repoId === payload.repoId,
  )?.branch;
  const branch =
    named ?? branchNames(spec.branch_namespace).integration(spec.slug);
  const recut: { branch: string; planningSha?: string } = { branch };
  if (
    spec.planning_repo_id === payload.repoId &&
    spec.planning_state === "done" &&
    spec.planning_docs_committed &&
    typeof spec.planning_sha === "string"
  ) {
    recut.planningSha = spec.planning_sha;
  }
  return { ...task, recut };
}

interface BaselineGateResult {
  pass: boolean;
  reasons: string[];
  failingTests: string[];
  log?: string;
  steps?: unknown;
  failedStep?: string;
  tests?: number;
  skipped?: number;
  gate?: {
    commitSha: string;
    configSha: string;
    treeSha?: string;
    configBlob?: string;
    commandResults: unknown[];
    testsTotal?: number;
    testsSkipped?: number;
    testCases?: {
      name: string;
      classname: string;
      status: "passed" | "failed" | "skipped";
      file?: string;
      message?: string;
      flaky?: boolean;
    }[];
  };
}

function readResult(result: unknown): BaselineGateResult | undefined {
  const r = result as Record<string, unknown> | null;
  if (r?.stage !== BASELINE_GATE_JOB) return undefined;
  if (typeof r.pass !== "boolean") return undefined;
  const reasons = Array.isArray(r.reasons)
    ? r.reasons.filter((item): item is string => typeof item === "string")
    : [];
  const failingTests = Array.isArray(r.failingTests)
    ? r.failingTests.filter((item): item is string => typeof item === "string")
    : failedTestNames(r);
  const log = typeof r.log === "string" ? r.log : undefined;
  const gate = readGateFacts(r.gate);
  return {
    pass: r.pass,
    reasons,
    failingTests,
    ...(log !== undefined ? { log } : {}),
    ...(r.steps !== undefined ? { steps: r.steps } : {}),
    ...(typeof r.failedStep === "string" ? { failedStep: r.failedStep } : {}),
    ...(typeof r.tests === "number" ? { tests: r.tests } : {}),
    ...(typeof r.skipped === "number" ? { skipped: r.skipped } : {}),
    ...(gate ? { gate } : {}),
  };
}

function failedTestNames(r: Record<string, unknown>): string[] {
  const cases = r.failingTests;
  if (Array.isArray(cases)) {
    return cases.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const rec = item as { classname?: unknown; name?: unknown };
        if (typeof rec.name === "string") {
          return [
            typeof rec.classname === "string" && rec.classname !== ""
              ? `${rec.classname} ${rec.name}`
              : rec.name,
          ];
        }
      }
      return [];
    });
  }
  const gate = r.gate;
  if (gate && typeof gate === "object") {
    const listed = (gate as { testCases?: unknown }).testCases;
    if (Array.isArray(listed)) {
      return listed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const rec = item as {
          status?: unknown;
          classname?: unknown;
          name?: unknown;
        };
        if (rec.status !== "failed" || typeof rec.name !== "string") return [];
        return [
          typeof rec.classname === "string" && rec.classname !== ""
            ? `${rec.classname} ${rec.name}`
            : rec.name,
        ];
      });
    }
  }
  return [];
}

function readGateFacts(
  raw: unknown,
): NonNullable<BaselineGateResult["gate"]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const gate = raw as Record<string, unknown>;
  if (typeof gate.commitSha !== "string" || typeof gate.configSha !== "string")
    return undefined;
  return {
    commitSha: gate.commitSha,
    configSha: gate.configSha,
    ...(typeof gate.treeSha === "string" ? { treeSha: gate.treeSha } : {}),
    ...(typeof gate.configBlob === "string"
      ? { configBlob: gate.configBlob }
      : {}),
    commandResults: Array.isArray(gate.commandResults)
      ? gate.commandResults
      : [],
    ...(typeof gate.testsTotal === "number"
      ? { testsTotal: gate.testsTotal }
      : {}),
    ...(typeof gate.testsSkipped === "number"
      ? { testsSkipped: gate.testsSkipped }
      : {}),
    ...(Array.isArray(gate.testCases)
      ? {
          testCases: gate.testCases as NonNullable<
            BaselineGateResult["gate"]
          >["testCases"],
        }
      : {}),
  };
}

export async function recordBaselineResult(
  client: pg.PoolClient,
  job: { id: number; payload: Record<string, unknown>; type?: string },
  result: unknown,
): Promise<"recorded" | "not-baseline"> {
  const payload = readBaselineGatePayload(job);
  if (!payload) return "not-baseline";
  const answer = readResult(result);
  if (!answer) throw new Error("not a baseline-gate result");
  await client.query("SELECT 1 FROM specs WHERE id = $1 FOR UPDATE", [
    payload.specId,
  ]);
  if (answer.gate) {
    const testCasesHash = await rememberGateTestCases(
      client,
      answer.gate.testCases,
    );
    await client.query(
      `INSERT INTO gate_results (repo_id, commit_sha, config_sha, command_results, tests_total, tests_skipped, test_cases_hash, kind,
         tree_sha, config_blob)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'baseline-gate', $8, $9)
       ON CONFLICT (repo_id, commit_sha, kind) DO UPDATE SET config_sha = EXCLUDED.config_sha,
         tree_sha = EXCLUDED.tree_sha, config_blob = EXCLUDED.config_blob,
         command_results = EXCLUDED.command_results, tests_total = EXCLUDED.tests_total,
         tests_skipped = EXCLUDED.tests_skipped, test_cases_hash = EXCLUDED.test_cases_hash`,
      [
        payload.repoId,
        answer.gate.commitSha,
        answer.gate.configSha,
        JSON.stringify(answer.gate.commandResults),
        answer.gate.testsTotal ?? null,
        answer.gate.testsSkipped ?? null,
        testCasesHash,
        answer.gate.treeSha ?? null,
        answer.gate.configBlob ?? null,
      ],
    );
  }
  const output: Record<string, unknown> = {
    reasons: answer.reasons,
    failingTests: answer.failingTests,
    ...(answer.log !== undefined ? { log: answer.log } : {}),
    ...(answer.failedStep !== undefined
      ? { failedStep: answer.failedStep }
      : {}),
  };
  await client.query(
    `INSERT INTO runs (spec_id, repo_id, job_id, stage, attempt, result, output, started_at, finished_at)
     SELECT $1, $2, $3, $4,
       (SELECT count(*) FROM runs r WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = $4) + 1,
       $5, $6::jsonb, now(), now()
     ON CONFLICT (job_id) DO UPDATE SET
       result = EXCLUDED.result, output = EXCLUDED.output, finished_at = COALESCE(runs.finished_at, now())`,
    [
      payload.specId,
      payload.repoId,
      job.id,
      BASELINE_GATE_JOB,
      answer.pass ? "passed" : "failed",
      JSON.stringify(output),
    ],
  );
  const hold = await settleBaselineJobs(client, payload.specId);
  if (hold === "ready") {
    await resumeAfterBaselinePass(client, payload.specId);
    const { schedulePass } = await import("../scheduling/scheduler.ts");
    const scheduled = await schedulePass(client, payload.specId);
    if (!scheduled.paused) {
      const project = await client.query<{ project_id: number }>(
        "SELECT project_id FROM specs WHERE id = $1",
        [payload.specId],
      );
      if (project.rows[0])
        await enqueueHostSync(client, project.rows[0].project_id);
    }
  }
  return "recorded";
}

async function settleBaselineJobs(
  client: pg.PoolClient,
  specId: number,
): Promise<BaselineGateHold> {
  const spec = await client.query<{
    baseline_gate_state: BaselineGateState | null;
  }>("SELECT baseline_gate_state FROM specs WHERE id = $1", [specId]);
  const gateState = spec.rows[0]?.baseline_gate_state;
  if (gateState === "done" || gateState === "waived") return "ready";
  if (gateState !== "pending") return "waiting";
  const { rows } = await client.query<{
    id: number;
    state: string;
    payload: { repoId?: number };
    result: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON ((payload->>'repoId')::int) id, state, payload, result
     FROM jobs
     WHERE type = $1 AND (payload->>'specId')::int = $2
     ORDER BY (payload->>'repoId')::int, id DESC`,
    [BASELINE_GATE_JOB, specId],
  );
  if (rows.length === 0) return "waiting";
  if (rows.some((row) => row.state === "queued" || row.state === "running"))
    return "waiting";
  const failed = rows.some((row) => {
    if (row.state === "failed") return true;
    const pass = row.result?.pass;
    return pass === false;
  });
  if (failed) {
    await pauseForBaseline(client, specId);
    return "paused";
  }
  await client.query(
    "UPDATE specs SET baseline_gate_state = 'done' WHERE id = $1 AND baseline_gate_state = 'pending'",
    [specId],
  );
  return "ready";
}

async function resumeAfterBaselinePass(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const current = await client.query<{
    state: string;
    pause_reason: string | null;
  }>("SELECT state, pause_reason FROM specs WHERE id = $1", [specId]);
  const row = current.rows[0];
  if (row?.state !== "paused" || row.pause_reason !== "baseline-gate-failed")
    return;
  const next = specTransition("paused", "resume");
  if (!next.ok) return;
  await client.query(
    "UPDATE specs SET state = $2, pause_reason = NULL WHERE id = $1",
    [specId, next.state],
  );
}

async function pauseForBaseline(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const current = await client.query<{ state: string }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  const state = current.rows[0]?.state;
  if (state !== "running" && state !== "reworking") return;
  const paused = specTransition(state as "running" | "reworking", "pause");
  if (!paused.ok) return;
  await client.query(
    "UPDATE specs SET state = $2, pause_reason = $3 WHERE id = $1",
    [specId, paused.state, "baseline-gate-failed"],
  );
}

export async function baselineGateFailed(
  client: pg.PoolClient,
  payload: BaselineGatePayload,
  maxFailures: number,
): Promise<"requeued" | "blocked" | "ignored"> {
  const { rows } = await client.query<{
    baseline_gate_state: string | null;
  }>("SELECT baseline_gate_state FROM specs WHERE id = $1 FOR UPDATE", [
    payload.specId,
  ]);
  if (rows[0]?.baseline_gate_state !== "pending") return "ignored";
  const jobs = await client.query<{ state: string }>(
    "SELECT state FROM jobs WHERE idempotency_key LIKE $1 ORDER BY id DESC",
    [`${keyPrefix(payload.specId, payload.repoId)}%`],
  );
  const inARow = jobs.rows.findIndex((j) => j.state !== "failed");
  const failures = inARow === -1 ? jobs.rows.length : inARow;
  if (failures < maxFailures) {
    const sha =
      payload.sha ??
      (
        await client.query<{ default_sha: string | null }>(
          "SELECT default_sha FROM repos WHERE id = $1",
          [payload.repoId],
        )
      ).rows[0]?.default_sha;
    if (typeof sha === "string" && SHA_RE.test(sha))
      await enqueueBaselineGate(
        client,
        payload.specId,
        payload.repoId,
        sha,
        payload.recut === true,
      );
    return "requeued";
  }
  await pauseForBaseline(client, payload.specId);
  return "blocked";
}

export interface BaselineFailure {
  repo: string;
  reasons: string[];
  failingTests: string[];
  log?: string;
  run: { id: number; displayId: string } | null;
}

export async function baselineFailuresOf(
  pool: Queryable,
  specId: number,
): Promise<BaselineFailure[]> {
  const { rows } = await pool.query<{
    name: string;
    reasons: unknown;
    failing_tests: unknown;
    log: string | null;
    run_id: number | null;
  }>(
    `SELECT r.name,
            COALESCE(run.output->'reasons', j.result->'reasons', '[]'::jsonb) AS reasons,
            COALESCE(run.output->'failingTests', j.result->'failingTests', '[]'::jsonb) AS failing_tests,
            COALESCE(run.output->>'log', j.result->>'log') AS log,
            run.id AS run_id
     FROM (
       SELECT DISTINCT ON ((payload->>'repoId')::int) id, payload, result, state
       FROM jobs
       WHERE type = $2 AND (payload->>'specId')::int = $1
       ORDER BY (payload->>'repoId')::int, id DESC
     ) j
     JOIN repos r ON r.id = (j.payload->>'repoId')::int
     LEFT JOIN runs run ON run.job_id = j.id
     WHERE j.state = 'failed'
        OR (j.result->>'pass') = 'false'
        OR run.result = 'failed'
     ORDER BY r.name`,
    [specId, BASELINE_GATE_JOB],
  );
  return rows.map((row) => ({
    repo: row.name,
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((item): item is string => typeof item === "string")
      : [],
    failingTests: Array.isArray(row.failing_tests)
      ? row.failing_tests.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    ...(row.log ? { log: row.log } : {}),
    run: row.run_id
      ? { id: row.run_id, displayId: formatDisplayId("run", row.run_id) }
      : null,
  }));
}

export async function recutBaselineCuts(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  const spec = await client.query<{
    integration_branches: IntegrationBranch[];
  }>("SELECT integration_branches FROM specs WHERE id = $1", [specId]);
  const branches = spec.rows[0]?.integration_branches ?? [];
  if (branches.length === 0) return;
  const ids = branches.map((branch) => branch.repoId);
  const { rows } = await client.query<{
    id: number;
    default_sha: string | null;
  }>("SELECT id, default_sha FROM repos WHERE id = ANY($1::int[])", [ids]);
  const shaById = new Map(rows.map((row) => [row.id, row.default_sha]));
  await client.query(
    "UPDATE specs SET integration_branches = $2 WHERE id = $1",
    [
      specId,
      JSON.stringify(
        branches.map((branch) =>
          integrationBranch(
            branch.repoId,
            branch.branch,
            shaById.get(branch.repoId),
          ),
        ),
      ),
    ],
  );
}

export async function enqueueBaselineGates(
  client: pg.PoolClient,
  specId: number,
  options: { recut?: boolean } = {},
): Promise<void> {
  await client.query(
    "UPDATE specs SET baseline_gate_state = NULL WHERE id = $1",
    [specId],
  );
  await holdForBaselineGate(client, specId, options);
}
