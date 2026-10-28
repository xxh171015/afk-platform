import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRunner,
  changedFiles,
  checkProtectedPaths,
  classifyAgentRun,
  classifyReviewRun,
  type GateCache,
  type GateOutcome,
  type GateSandbox,
  git,
  gitOrThrow,
  ImplementOutputSchema,
  isAncestor,
  mergeCandidate,
  promptFor,
  ReviewOutputSchema,
  readContract,
  renderContext,
  reviewFindings,
  runGate,
  stampTrailers,
} from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import type { PushFn } from "./push.ts";
import type { RepoStore } from "./repos.ts";
import { retrieveResult, type Slot, type SlotManager } from "./slots.ts";

// Runs one stage of one ticket and returns the facts for the API: what the worker is for. Which stage comes next,
// and whether the ticket is blocked, is the API's decision (docs/specs/m1-platform.md「谁决定下一步」).

export interface ExecutorDeps {
  slots: SlotManager;
  repos: RepoStore;
  push: PushFn;
  api: Pick<WorkerApi, "prePush">; // supplied by the worker loop
  gateCache: GateCache;
  makeAgentRunner(slotDir: string): AgentRunner;
  makeGateSandbox(slotDir: string): GateSandbox;
  tmpRoot?: string;
  idleSeconds: number;
  wallClockMs: number;
}

export interface StageContext {
  job: ClaimedJob;
  bundle: Bundle;
  signal: AbortSignal;
  log: (line: string) => void;
}

// A problem with the worker's own environment, not with the ticket: the job fails and is dispatched again.
export class InfrastructureError extends Error {}
// The lease is gone; whatever was done must not be reported.
export class JobLostError extends Error {}

export type StageOutcomeBody = Record<string, unknown> & {
  stage: string;
  outcome: string;
};

const agentRef = (bundle: Bundle) => `agent/${bundle.ticket.displayId}`;
const successful = new Set(["done", "passed", "pass", "merged"]);
export const isSuccess = (body: StageOutcomeBody) =>
  successful.has(body.outcome);

export async function executeStage(
  deps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  if (!bundle.integrationBranch)
    throw new InfrastructureError(
      "the spec has no integration branch for this repo",
    );
  const mainDir = deps.repos.ensure(
    bundle.repo.role,
    bundle.repo.url,
    bundle.repo.defaultBranch,
  );
  ensureIntegrationBranch(deps, mainDir, bundle);

  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.role,
    ref: agentRef(bundle),
  });
  if (!slot) throw new InfrastructureError("no free slot");
  let body: StageOutcomeBody | undefined;
  try {
    body = await runStage(deps, context, mainDir, slot);
    return body;
  } finally {
    await slot.release(body && isSuccess(body) ? "success" : "failure");
  }
}

// The integration branch is made from the default branch the first time any stage of the spec needs it.
function ensureIntegrationBranch(
  deps: ExecutorDeps,
  mainDir: string,
  bundle: Bundle,
) {
  const branch = bundle.integrationBranch as string;
  if (deps.repos.has(mainDir, `refs/heads/${branch}`)) return;
  const base = gitOrThrow(mainDir, ["rev-parse", bundle.repo.defaultBranch]);
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, base]);
  const pushed = deps.push({
    repoDir: mainDir,
    source: `refs/heads/${branch}`,
    target: `refs/heads/${branch}`,
  });
  if (!pushed.ok)
    throw new InfrastructureError(
      `could not create ${branch}: ${pushed.error}`,
    );
}

// Branches a slot needs to find in its clone, fetched from the main clone.
function bringBranches(slot: Slot, mainDir: string, refs: string[]) {
  for (const ref of refs) {
    if (
      git(mainDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`])
        .code !== 0
    )
      continue;
    gitOrThrow(slot.dir, [
      "fetch",
      "--quiet",
      "--no-tags",
      mainDir,
      `+refs/heads/${ref}:refs/heads/${ref}`,
    ]);
  }
}

async function runStage(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const integration = bundle.integrationBranch as string;
  bringBranches(slot, mainDir, [integration, agentRef(bundle)]);
  switch (bundle.job.stage) {
    case "implement":
    case "gate-fix":
    case "review-fix":
    case "merge-fix":
      return agentChange(deps, context, mainDir, slot);
    case "review":
      return review(deps, context, mainDir, slot);
    case "gate":
      return gate(deps, context, mainDir, slot);
    case "merge":
      return merge(deps, context, mainDir, slot);
    default:
      throw new InfrastructureError(`unknown stage ${bundle.job.stage}`);
  }
}

const tip = (dir: string, ref: string) => gitOrThrow(dir, ["rev-parse", ref]);
const exists = (dir: string, ref: string) =>
  git(dir, ["rev-parse", "--verify", "--quiet", ref]).code === 0;

function renderFor(
  context: StageContext,
  mainDir: string,
  baseSha: string,
  ctxRoot: string,
) {
  const { bundle } = context;
  const dir = join(ctxRoot, "context");
  renderContext({
    dir,
    bundle,
    run: {
      runId: bundle.run?.displayId ?? "R-0",
      baseSha,
      branch: agentRef(bundle),
    },
    ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
    ...(bundle.review ? { review: bundle.review } : {}),
    ...(bundle.contract
      ? { contract: readContract(mainDir, bundle.contract) }
      : {}),
  });
  return dir;
}

// The commit the ticket branch started from: where it left the integration branch.
function branchBase(dir: string, integration: string, agent: string): string {
  return exists(dir, agent)
    ? gitOrThrow(dir, ["merge-base", integration, agent])
    : tip(dir, integration);
}

async function agentChange(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const stage = bundle.job.stage as
    | "implement"
    | "gate-fix"
    | "review-fix"
    | "merge-fix";
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
  const baseSha = branchBase(mainDir, integration, agent);
  const before = exists(mainDir, agent) ? tip(mainDir, agent) : baseSha;
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(context, mainDir, baseSha, tmp);
    log(`${stage}: running the agent on ${agent}`);
    const run = await deps.makeAgentRunner(slot.dir).run({
      stage,
      branch: agent,
      baseBranch: integration,
      promptFile: promptFor(stage),
      ctxDir,
      schema: ImplementOutputSchema,
      idleSeconds: deps.idleSeconds,
      wallClockMs: deps.wallClockMs,
      signal: context.signal,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the agent run");
    const verdict = classifyAgentRun(run);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error);
    log(
      `${stage}: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    );

    const facts: Record<string, unknown> = {
      branch: agent,
      baseSha,
      commits: run.commits,
      durationMs: run.durationMs,
      output: run.output ?? { error: run.error },
    };
    if (verdict.outcome !== "done")
      return { stage, outcome: verdict.outcome, run: facts };

    // Take the commits back from the slot, stamp them, and publish the branch.
    const taken = retrieveResult({
      slotClone: slot.dir,
      mainClone: mainDir,
      ref: agent,
      log,
    });
    if (!taken.fetched)
      throw new InfrastructureError(
        `could not take ${agent} back: ${taken.error ?? "no such branch in the slot"}`,
      );
    const stamped = stampTrailers({
      repoDir: mainDir,
      branch: agent,
      before,
      exclude: integration,
      ids: {
        spec: bundle.spec.displayId,
        ticket: bundle.ticket.displayId,
        run: bundle.run?.displayId ?? "R-0",
      },
    });
    if (stamped.error)
      throw new InfrastructureError(`stamping failed: ${stamped.error}`);
    const pushed = deps.push({
      repoDir: mainDir,
      source: `refs/heads/${agent}`,
      target: `refs/heads/${agent}`,
    });
    if (!pushed.ok)
      throw new InfrastructureError(`push failed: ${pushed.error}`);
    facts.headSha = tip(mainDir, agent);
    facts.commits = gitOrThrow(mainDir, [
      "rev-list",
      "--reverse",
      `${before}..${agent}`,
    ])
      .split("\n")
      .filter(Boolean);
    return { stage, outcome: "done", run: facts };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function review(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = agentRef(bundle);
  const baseSha = branchBase(
    mainDir,
    bundle.integrationBranch as string,
    agent,
  );
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = renderFor(context, mainDir, baseSha, tmp);
    const run = await deps.makeAgentRunner(slot.dir).run({
      stage: "review",
      branch: agent,
      baseBranch: bundle.integrationBranch as string,
      promptFile: promptFor("review"),
      ctxDir,
      schema: ReviewOutputSchema,
      idleSeconds: deps.idleSeconds,
      wallClockMs: deps.wallClockMs,
      signal: context.signal,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the review");
    const verdict = classifyReviewRun(run);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error);
    log(`review: ${verdict.outcome}`);
    return {
      stage: "review",
      outcome: verdict.outcome,
      run: {
        branch: agent,
        baseSha,
        commits: run.commits,
        durationMs: run.durationMs,
        output: run.output ?? { error: run.error },
      },
      findings: run.output ? reviewFindings(run.output) : [],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function gateFacts(outcome: GateOutcome) {
  return {
    commitSha: outcome.commitSha,
    configSha: outcome.configSha,
    commandResults: outcome.steps,
    ...(outcome.counts
      ? {
          testsTotal: outcome.counts.tests,
          testsSkipped: outcome.counts.skipped,
        }
      : {}),
  };
}

function logGate(log: (line: string) => void, outcome: GateOutcome) {
  for (const step of outcome.steps)
    log(`gate: ${step.name} exit ${step.exitCode} (${step.ms} ms)`);
  for (const [name, text] of Object.entries(outcome.stepLogs))
    log(`--- ${name} ---\n${text}`);
}

async function gate(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
  if (!exists(mainDir, agent))
    throw new InfrastructureError(`${agent} is not there to gate`);
  const baseSha = branchBase(mainDir, integration, agent);

  const changed = changedFiles(mainDir, baseSha, agent);
  const check = checkProtectedPaths({
    changed,
    protectedPaths: bundle.protectedPaths,
    approved: bundle.allowedProtectedPaths,
  });
  if (check.unapproved.length > 0) {
    log(
      `gate: protected paths changed without approval: ${check.unapproved.join(", ")}`,
    );
    return {
      stage: "gate",
      outcome: "protected-path-changed",
      run: { branch: agent, baseSha, output: { unapproved: check.unapproved } },
    };
  }

  // The gate configuration comes from the integration branch, not from the ticket's branch.
  const outcome = await runGate({
    repoDir: mainDir,
    sandbox: deps.makeGateSandbox(slot.dir),
    ref: agent,
    commitSha: tip(mainDir, agent),
    configSha: tip(mainDir, integration),
    cache: deps.gateCache,
  });
  if (context.signal.aborted)
    throw new JobLostError("the lease was lost during the gate");
  logGate(log, outcome);
  return {
    stage: "gate",
    outcome: outcome.pass ? "passed" : "failed",
    run: {
      branch: agent,
      baseSha,
      headSha: outcome.commitSha,
      output: { failureLog: outcome.failureLog, reasons: outcome.reasons },
    },
    gate: gateFacts(outcome),
  };
}

async function merge(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log, job } = context;
  const agent = agentRef(bundle);
  const integration = bundle.integrationBranch as string;
  const integrationRef = `refs/heads/${integration}`;
  const gateBranch = `gate/${bundle.ticket.displayId}`;

  // Already merged (a previous attempt got as far as the push): say so instead of merging twice.
  if (isAncestor(mainDir, agent, integration)) {
    log(`merge: ${agent} is already part of ${integration}`);
    return {
      stage: "merge",
      outcome: "merged",
      headSha: tip(mainDir, integration),
    };
  }

  const oldTip = tip(mainDir, integration);
  const candidate = mergeCandidate(
    mainDir,
    integration,
    agent,
    `Merge ${agent} into ${integration}\n\nTicket: ${bundle.ticket.displayId}`,
  );
  if (candidate.conflict) {
    log(`merge: conflict in ${candidate.files.join(", ")}`);
    return {
      stage: "merge",
      outcome: "conflict",
      run: {
        output: {
          failureLog: `# merge conflict\n\n${agent} cannot be merged into ${integration}:\n${candidate.files.map((f) => `- ${f}`).join("\n")}\n`,
        },
      },
    };
  }

  // The candidate is gated on a branch of its own; only a passing candidate moves the integration branch.
  gitOrThrow(mainDir, [
    "update-ref",
    `refs/heads/${gateBranch}`,
    candidate.candidate,
  ]);
  try {
    bringBranches(slot, mainDir, [gateBranch]);
    const outcome = await runGate({
      repoDir: mainDir,
      sandbox: deps.makeGateSandbox(slot.dir),
      ref: gateBranch,
      commitSha: candidate.candidate,
      configSha: oldTip,
      cache: deps.gateCache,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the candidate gate");
    logGate(log, outcome);
    if (!outcome.pass) {
      return {
        stage: "merge",
        outcome: "gate-failed",
        run: {
          output: { failureLog: outcome.failureLog, reasons: outcome.reasons },
        },
        gate: gateFacts(outcome),
      };
    }
    // Still the holder? This check renews the lease as well.
    if ((await deps.api.prePush(job)) === "lost")
      throw new JobLostError("the lease was lost before the push");
    const pushed = deps.push({
      repoDir: mainDir,
      source: candidate.candidate,
      target: integrationRef,
      expectedOld: oldTip,
    });
    if (!pushed.ok)
      throw new InfrastructureError(
        `could not advance ${integration}: ${pushed.error}`,
      );
    gitOrThrow(mainDir, ["update-ref", integrationRef, candidate.candidate]);
    log(`merge: ${integration} is now ${candidate.candidate}`);
    return {
      stage: "merge",
      outcome: "merged",
      headSha: candidate.candidate,
      gate: gateFacts(outcome),
    };
  } finally {
    git(mainDir, ["update-ref", "-d", `refs/heads/${gateBranch}`]);
  }
}
