import { join } from "node:path";
import {
  type AgentRunner,
  type DockerCli,
  type Environment,
  EnvironmentError,
  type EnvironmentRepo,
  failedCasesOf,
  GateConfigError,
  type GateOutcome,
  type GateRecords,
  type GateSandbox,
  GateSetupError,
  git,
  gitOrThrow,
  hasRef,
  isAncestor,
  projectOf,
  type RunGateInput,
  readGateConfig,
  reclaimEnvironments,
  renderContext,
  runGate,
  startEnvironment,
} from "@afk/pipeline";
import {
  type Bundle,
  classifyPushError,
  formatPushFailure,
  isDeterministicPushFailure,
  modelFor,
  type PushFailureTips,
  type ReviewAxis,
  unrecoverableJobError,
} from "@afk/shared";
import { originSha, type TicketAlign } from "../align-ticket-branch.ts";
import type { ClaimedJob, WorkerApi } from "../api.ts";
import { fetchContracts } from "../contracts.ts";
import type { Credentials } from "../credentials.ts";
import { fetchDomain } from "../domain.ts";
import type { EnvironmentLimiter } from "../environments.ts";
import type { PushFn } from "../push.ts";
import { sanitizeRawLine } from "../raw-log.ts";
import type { RepoStore } from "../repos.ts";
import type { Slot, SlotManager } from "../slots.ts";
import type { SnapshotStore } from "../snapshots.ts";

export interface ExecutorDeps {
  slots: SlotManager;
  repos: RepoStore;
  snapshots: SnapshotStore;
  push: PushFn;
  credentials?: Credentials; // tokens for the code host; without them git uses whatever it is already set up with
  api: Pick<WorkerApi, "prePush" | "gateResult">; // supplied by the worker loop
  // What an integration environment needs: docker, and the limit on how many a worker runs at once.
  docker?: DockerCli;
  environments?: EnvironmentLimiter;
  makeAgentRunner(slotDir: string, runId?: string): AgentRunner;
  makeGateSandbox(slotDir: string, runId?: string): GateSandbox;
  tmpRoot?: string;
  model?: string; // the worker's own model: what a project that sets none gets
  skillsSha?: string; // the skills version the worker checked at start-up; recorded on every agent Run
  secrets?: readonly string[]; // kept out of the raw event lines that are uploaded
  // A push that hit the network waits this long before retrying; tests replace it so they do not wait out 10–180 s.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StageContext {
  job: ClaimedJob;
  bundle: Bundle;
  signal: AbortSignal;
  log: (line: string) => void;
  logRaw: (line: string) => void; // goes to the Run's log only, not to the worker's own output
  align?: TicketAlign;
}

// What a run is asked for, from the project's say (the bundle) and the worker's own defaults.
export function runOptions(
  deps: ExecutorDeps,
  context: StageContext,
  axis?: ReviewAxis,
) {
  const { bundle } = context;
  const model = modelFor({
    stage: bundle.job.stage,
    axis,
    stageModels: bundle.stageModels,
    defaultModel: bundle.model,
    workerModel: deps.model,
  });
  return {
    idleSeconds: bundle.limits.runIdleSeconds,
    wallClockMs: bundle.limits.runWallclockSeconds * 1000,
    ...(model ? { model } : {}),
    onRawLine: (line: string) =>
      context.logRaw(sanitizeRawLine(line, deps.secrets ?? [])),
  };
}

// Usage, API duration and CLI version from the Cursor result line, to keep on a Run after the agent.
export function billedFacts(
  run: {
    tokenUsage?: unknown;
    durationApiMs?: number;
    cursorCliVersion?: string;
  } = {},
) {
  return {
    ...(run.tokenUsage !== undefined ? { tokenUsage: run.tokenUsage } : {}),
    ...(run.durationApiMs !== undefined
      ? { durationApiMs: run.durationApiMs }
      : {}),
    ...(run.cursorCliVersion ? { cursorCliVersion: run.cursorCliVersion } : {}),
  };
}

type BilledFacts = ReturnType<typeof billedFacts> & { axis?: ReviewAxis };

// What a Run records about the agent that ran: model, skills, prompt, and the Cursor result-line facts.
export function agentFacts(
  deps: ExecutorDeps,
  options: { model?: string },
  prompt: string,
  run?: {
    tokenUsage?: unknown;
    durationApiMs?: number;
    cursorCliVersion?: string;
    resultFix?: "normalized" | "repaired";
  },
) {
  return {
    prompt,
    ...(options.model ? { model: options.model } : {}),
    ...(deps.skillsSha ? { skillsSha: deps.skillsSha } : {}),
    ...billedFacts(run),
    ...(run?.resultFix ? { resultFix: run.resultFix } : {}),
  };
}

// A problem with the worker's own environment, not with the ticket: the job fails and is dispatched again,
// unless the error is one that will not recover by running it again (Cursor auth, a bad model, a spent quota,
// a failed integration image build). Those are rewritten here to the human sentence the brief shows.
export class InfrastructureError extends Error {
  readonly run?: BilledFacts;
  readonly extraRuns?: BilledFacts[];
  orphanRef?: string;
  orphanSha?: string;
  constructor(message: string, run?: BilledFacts, extraRuns?: BilledFacts[]) {
    super(unrecoverableJobError(message) ?? message);
    this.run = run;
    this.extraRuns = extraRuns;
  }
}
// Nothing to run on right now: every slot is taken. The job is left alone and comes back when its lease runs out.
export class NoFreeSlotError extends Error {}
// The lease is gone; whatever was done must not be reported.
export class JobLostError extends Error {}

export type StageOutcomeBody = Record<string, unknown> & {
  stage: string;
  outcome: string;
};

// The Run is created when the job is claimed, so a bundle without one means the API and the worker disagree.
export const runIdOf = (bundle: Bundle): string => {
  if (!bundle.run) throw new InfrastructureError("the bundle has no run");
  return bundle.run.displayId;
};

// The label of what a stage works on (its gate branch is named after it): a ticket, or the overall fix of a spec.
export const subjectLabel = (bundle: Bundle) => {
  if (bundle.ticket) return bundle.ticket.displayId;
  if (bundle.job.stage === "update-branch")
    return `${bundle.spec.displayId}-update`;
  return `${bundle.spec.displayId}-final`;
};
const successful = new Set(["done", "passed", "pass", "merged"]);
export const isSuccess = (body: StageOutcomeBody) =>
  successful.has(body.outcome);

// Branches a slot needs to find in its clone, fetched from the main clone.
export function bringBranches(slot: Slot, mainDir: string, refs: string[]) {
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

export async function assertRemoteUnchanged(
  repoDir: string,
  branch: string,
  expectedOld: string,
  signal: AbortSignal,
  run?: ReturnType<typeof billedFacts>,
): Promise<void> {
  const now = (await originSha(repoDir, branch, { signal })) ?? "";
  if (now !== expectedOld) {
    throwPushFailure(
      "stale info",
      {
        remoteTip: now,
        startedFrom: expectedOld,
      },
      run,
    );
  }
}

export async function publishLocalAhead(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  agent: string,
): Promise<void> {
  const local = hasRef(mainDir, `refs/heads/${agent}`)
    ? tip(mainDir, agent)
    : undefined;
  const remote = await originSha(mainDir, agent, { signal: context.signal });
  if (
    !local ||
    !remote ||
    local === remote ||
    !isAncestor(mainDir, remote, local)
  )
    return;
  if (
    context.signal.aborted ||
    (await deps.api.prePush(context.job)) === "lost"
  ) {
    throw new JobLostError("the lease was lost before the push");
  }
  const pushed = await deps.push({
    repoDir: mainDir,
    source: `refs/heads/${agent}`,
    target: `refs/heads/${agent}`,
    expectedOld: remote,
  });
  if (!pushed.ok) {
    throwPushFailure(pushed.error, {
      remoteTip:
        (await tipAfterFailedPush(mainDir, agent, context.signal)) ?? "",
      startedFrom: remote,
    });
  }
}

// Where origin's branch is after a push failed, for the failure's facts; origin out of reach leaves it unknown
// rather than hiding the push's own error.
export const tipAfterFailedPush = (
  mainDir: string,
  branch: string,
  signal: AbortSignal,
): Promise<string | undefined> =>
  originSha(mainDir, branch, { signal }).catch(() => undefined);

export async function publishedTip(
  mainDir: string,
  agent: string,
  signal: AbortSignal,
): Promise<string> {
  const remote = await originSha(mainDir, agent, { signal });
  const local = hasRef(mainDir, `refs/heads/${agent}`)
    ? tip(mainDir, agent)
    : undefined;
  if (remote && local && remote !== local) {
    throwPushFailure("stale info", {
      remoteTip: remote,
      startedFrom: local,
    });
  }
  const sha = remote ?? local;
  if (!sha)
    throw new InfrastructureError(`${agent} is not on origin or locally`);
  return sha;
}

export const tip = (dir: string, ref: string) =>
  gitOrThrow(dir, ["rev-parse", ref]);
export const exists = hasRef;

export function throwPushFailure(
  error: string,
  tips: PushFailureTips,
  run?: ReturnType<typeof billedFacts>,
): never {
  const kind = classifyPushError(error);
  if (isDeterministicPushFailure(kind)) {
    throw new InfrastructureError(
      formatPushFailure(error, {
        remoteTip: tips.remoteTip ?? "",
        startedFrom: tips.startedFrom ?? "",
      }),
      run,
    );
  }
  throw new InfrastructureError(`push failed: ${error}`, run);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function renderFor(
  deps: ExecutorDeps,
  context: StageContext,
  baseSha: string,
  ctxRoot: string,
  mainDir: string,
) {
  const { bundle } = context;
  const dir = join(ctxRoot, "context");
  const domainFiles = await fetchDomain(
    deps.repos,
    bundle.domain,
    bundle.repo.name,
  );
  const contracts = bundle.contracts.length
    ? await fetchContracts(deps.repos, bundle.contracts)
    : [];
  const integration = bundle.integrationBranch;
  renderContext({
    dir,
    bundle,
    run: {
      runId: runIdOf(bundle),
      baseSha,
      branch: bundle.agentBranch,
    },
    ...(bundle.failureLog ? { failureLog: bundle.failureLog } : {}),
    ...(bundle.failedCases?.length ? { failedCases: bundle.failedCases } : {}),
    ...(bundle.review ? { review: bundle.review } : {}),
    ...(bundle.contracts.length ? { contracts } : {}),
    ...(domainFiles ? { domain: domainFiles } : {}),
    ...(integration
      ? { gate: readGateConfig(mainDir, tip(mainDir, integration)) }
      : {}),
  });
  return dir;
}

// Snapshots of repos at the SHA the bundle names (the head of the default branch when it names none): the ones
// the ticket refs, to be mounted read-only at /refs/<name>, or the ones an integration environment is built from.
// The SHAs go on the Run.
export async function snapshotRefs(
  deps: ExecutorDeps,
  bundle: Bundle,
  from: Bundle["refs"] = bundle.refs,
) {
  const refs: { name: string; dir: string }[] = [];
  const refShas: Record<string, string> = {};
  for (const ref of from) {
    const clone = await deps.repos.ensure(ref.name, ref.url, ref.defaultBranch);
    const sha = ref.sha ?? tip(clone, ref.defaultBranch);
    refs.push({
      name: ref.name,
      dir: deps.snapshots.ensure(ref.name, clone, sha),
    });
    refShas[ref.name] = sha;
  }
  return { refs, refShas };
}

// The commit the ticket branch started from: where it left the integration branch.
export function branchBase(
  dir: string,
  integration: string,
  agent: string,
): string {
  return exists(dir, agent)
    ? gitOrThrow(dir, ["merge-base", integration, agent])
    : tip(dir, integration);
}

export function gateFacts(outcome: GateOutcome) {
  return {
    commitSha: outcome.commitSha,
    configSha: outcome.configSha,
    treeSha: outcome.treeSha,
    configBlob: outcome.configBlob,
    commandResults: outcome.steps,
    ...(outcome.counts
      ? {
          testsTotal: outcome.counts.tests,
          testsSkipped: outcome.counts.skipped,
        }
      : {}),
    ...(outcome.testCases ? { testCases: outcome.testCases } : {}),
  };
}

export function gateFailureOutput(outcome: GateOutcome) {
  const failedCases = failedCasesOf(outcome.testCases);
  return {
    failureLog: outcome.failureLog,
    reasons: outcome.reasons,
    ...(failedCases ? { failedCases } : {}),
    ...(outcome.removedTests ? { removedTests: outcome.removedTests } : {}),
  };
}

export function gateOutcomeOf(
  outcome: GateOutcome,
): "passed" | "failed" | "tests-removed" {
  if (outcome.pass) return "passed";
  if (outcome.removedTests && outcome.removedTests.length > 0)
    return "tests-removed";
  return "failed";
}

export function logGate(log: (line: string) => void, outcome: GateOutcome) {
  if (outcome.reusedFrom)
    log(
      `gate: reused the result of ${outcome.reusedFrom}: the same tree under the same gates.yaml`,
    );
  for (const step of outcome.steps)
    log(`gate: ${step.name} exit ${step.exitCode} (${step.ms} ms)`);
  for (const [name, text] of Object.entries(outcome.stepLogs))
    log(`--- ${name} ---\n${text}`);
}

// Earlier gates of the job's repo, as the platform stored them.
export function gateRecords(
  deps: ExecutorDeps,
  context: StageContext,
): GateRecords {
  return {
    findPassed: (tree, configBlob) =>
      deps.api.gateResult(context.job, { tree, configBlob }),
  };
}

// A gate whose setup failed (dependencies would not install, a database would not start) says nothing about the
// change: the job fails and is dispatched again, instead of an agent being sent to fix the code.
export async function runGateStep(input: RunGateInput): Promise<GateOutcome> {
  try {
    return await runGate(input);
  } catch (error) {
    if (error instanceof GateSetupError)
      throw new InfrastructureError(error.message);
    if (error instanceof GateConfigError)
      throw new InfrastructureError(error.message);
    throw error;
  }
}

// A fresh integration environment, built from snapshots of the repos the ticket names (the heads of their integration
// branches, the default branch where the spec has not merged anything), in the order the ticket names them; `use`
// runs in it, and it is taken down again whatever `use` does. An environment that cannot be made fails the job (the
// API tries again, and blocks the ticket after three). Whoever starts a sandbox in it closes the sandbox before
// `use` returns: only then can compose take the network down.
export async function withEnvironment<T>(
  deps: ExecutorDeps,
  context: StageContext,
  label: string,
  use: (environment: Environment) => Promise<T>,
): Promise<T> {
  const { bundle, log } = context;
  const { docker, environments } = deps;
  if (!docker || !environments)
    throw new InfrastructureError(
      "this worker has no integration environments",
    );
  const { refs, refShas } = await snapshotRefs(
    deps,
    bundle,
    bundle.environment,
  );
  const repos: EnvironmentRepo[] = refs.map((ref) => ({
    name: ref.name,
    dir: ref.dir,
    sha: refShas[ref.name] as string,
  }));

  const runId = runIdOf(bundle);
  const project = projectOf(runId);
  const release = await environments
    .acquire(bundle.limits.maxIntegrationEnvironments, context.signal)
    .catch((error) => {
      throw new JobLostError(error.message);
    });
  environments.projects.add(project);
  let environment: Environment | undefined;
  try {
    // Environments a worker that was killed left behind go first: nothing else will remove them.
    await reclaimEnvironments({
      docker,
      keep: environments.projects,
      log,
    });
    try {
      environment = await startEnvironment({
        docker,
        runId,
        repos,
        signal: context.signal,
        log,
      });
    } catch (error) {
      if (context.signal.aborted)
        throw new JobLostError(
          "the lease was lost while the environment came up",
        );
      if (error instanceof EnvironmentError)
        throw new InfrastructureError(error.message);
      throw error;
    }
    log(
      `${label}: environment ${environment.project} is up after ${environment.upMs} ms`,
    );
    return await use(environment);
  } finally {
    await environment?.stop();
    environments.projects.delete(project);
    release();
  }
}
