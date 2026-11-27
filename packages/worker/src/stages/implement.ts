import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoMergeCommit,
  classifyAgentRun,
  GENERATED_UPSTREAM_ENV,
  git,
  gitOrThrow,
  ImplementOutputSchema,
  lastAssistantFromCursorLine,
  promptFor,
  RECHECK_REF_PREFIX,
  readGateConfig,
  recheckHit,
  reworkOutputSchema,
  type SandboxPlacement,
  stampTrailers,
  TidyOutputSchema,
  writePrompt,
} from "@afk/pipeline";
import { isNetworkPushError } from "@afk/shared";
import type { TicketAlign } from "../align-ticket-branch.ts";
import type { PushFn } from "../push.ts";
import { retrieveResult, type Slot } from "../slots.ts";
import {
  agentFacts,
  assertRemoteUnchanged,
  billedFacts,
  branchBase,
  type ExecutorDeps,
  exists,
  InfrastructureError,
  JobLostError,
  renderFor,
  runIdOf,
  runOptions,
  type StageContext,
  type StageOutcomeBody,
  sleep,
  snapshotRefs,
  throwPushFailure,
  tip,
  tipAfterFailedPush,
  withEnvironment,
} from "./common.ts";
import {
  RECOVER_AFTER_EXIT_STAGES,
  RECOVERED_AFTER_EXIT_NOTE,
  recoverAfterAbnormalExit,
} from "./recover-after-exit.ts";

const RECHECK_TRIGGER_STAGES = new Set([
  "review-fix",
  "merge-fix",
  "final-fix",
  "rework",
  "final-tidy",
  "update-branch",
]);

function reworkCommentIds(bundle: { reviewComments?: unknown }): string[] {
  const raw = bundle.reviewComments;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const comments = (raw as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return [];
  return comments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}

function commentsOf(output: unknown): unknown[] | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return undefined;
  const comments = (output as { comments?: unknown }).comments;
  return Array.isArray(comments) ? comments : undefined;
}

function extraRecheckConfig(repoDir: string, sha: string): string[] {
  try {
    return [...(readGateConfig(repoDir, sha).recheckConfig ?? [])];
  } catch {
    return [];
  }
}

function incomingForRecheck(
  stage: string,
  context: StageContext,
  mainDir: string,
  integration: string,
  defaultBranch: string,
): string | undefined {
  if (stage === "update-branch") {
    const mainSha = context.job.payload.mainSha;
    if (typeof mainSha === "string" && mainSha.length > 0) return mainSha;
    return tip(mainDir, defaultBranch);
  }
  if (stage === "merge-fix") return tip(mainDir, integration);
  return undefined;
}

export async function agentChange(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
  align: TicketAlign,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const stage = bundle.job.stage as
    | "implement"
    | "gate-fix"
    | "review-fix"
    | "merge-fix"
    | "update-branch"
    | "final-fix"
    | "rework"
    | "final-tidy";
  const agent = bundle.agentBranch;
  const integration = bundle.integrationBranch as string;
  const baseSha = branchBase(mainDir, integration, agent);
  const before = exists(mainDir, agent) ? tip(mainDir, agent) : baseSha;
  // Trailers only on commits origin does not already have. implement still owns unstamped salvaged
  // commits when this branch has never been on origin.
  const stampFrom =
    align.remoteTip ??
    (stage === "implement" &&
    !/^Run: /m.test(
      git(mainDir, ["log", "--format=%B", `${baseSha}..${before}`]).stdout,
    )
      ? baseSha
      : before);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = await renderFor(deps, context, baseSha, tmp, mainDir);
    const inEnvironment =
      bundle.ticket?.type === "integration" && bundle.environment.length > 0;
    const given = writePrompt(
      tmp,
      promptFor(stage, { integration: inEnvironment }),
    );
    const { refs, refShas } = await snapshotRefs(deps, bundle);
    log(`${stage}: running the agent on ${agent}`);
    const options = runOptions(deps, context);
    await assertRemoteUnchanged(
      mainDir,
      agent,
      align.expectedOld,
      context.signal,
    );
    const generatedUpstream =
      stage === "update-branch"
        ? tip(mainDir, bundle.repo.defaultBranch)
        : stage === "merge-fix"
          ? tip(mainDir, integration)
          : undefined;
    const generatedEnv = generatedUpstream
      ? { [GENERATED_UPSTREAM_ENV]: generatedUpstream }
      : undefined;
    const schema =
      stage === "final-tidy"
        ? TidyOutputSchema
        : stage === "rework"
          ? reworkOutputSchema(reworkCommentIds(bundle))
          : ImplementOutputSchema;
    const logDir = join(
      deps.sandboxLogsRoot ?? join(deps.tmpRoot ?? tmpdir(), "sandbox-logs"),
      runIdOf(bundle),
    );
    const resultDir = join(logDir, "afk-out");
    rmSync(resultDir, { recursive: true, force: true });
    mkdirSync(resultDir, { recursive: true });
    let lastAssistant: string | undefined;
    // An integration ticket's agent works in its integration environment: it writes the e2e against real services,
    // and a fix reproduces the failure there. The environment is gone again when the run is over.
    const runAgent = (placement?: SandboxPlacement) =>
      deps.makeAgentRunner(slot.dir, runIdOf(bundle), logDir).run({
        stage,
        branch: agent,
        baseBranch: integration,
        promptFile: given.promptFile,
        ctxDir,
        refs,
        schema,
        resultDir,
        ...(placement ? { placement } : {}),
        ...(generatedEnv ? { env: generatedEnv } : {}),
        ...options,
        onRawLine: (line) => {
          options.onRawLine?.(line);
          const text = lastAssistantFromCursorLine(line);
          if (text) lastAssistant = text;
        },
        signal: context.signal,
      });
    let run = inEnvironment
      ? await withEnvironment(deps, context, stage, (environment) =>
          runAgent({ network: environment.network, env: environment.env }),
        )
      : await runAgent();
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during the agent run");
    let recoveredError: string | undefined;
    if (RECOVER_AFTER_EXIT_STAGES.has(stage)) {
      const recovered = recoverAfterAbnormalExit({
        result: run,
        schema,
        resultDir,
        lastAssistant,
        slotDir: slot.dir,
        branch: agent,
        baseSha,
        inherited: before !== baseSha,
        requireCommit: true,
      });
      if (recovered.kind === "recovered") {
        run = recovered.result;
        recoveredError = recovered.originalError;
        log(RECOVERED_AFTER_EXIT_NOTE);
      } else if (recovered.kind === "job-failure") {
        throw new InfrastructureError(
          run.error ?? "agent exited",
          billedFacts(run),
        );
      }
    }
    // Commits the branch already carries (salvaged from an interrupted run, or kept by a continue-retry) are the
    // ticket's work: an agent that finds it complete adds none, and that is done, not no-commits.
    const inherited =
      stage === "implement" && before !== baseSha && run.commits.length === 0;
    const verdict = classifyAgentRun(
      inherited ? { ...run, commits: [before] } : run,
      { requireCommit: stage !== "rework" },
    );
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error, billedFacts(run));
    log(
      `${stage}: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
    );

    const billed = billedFacts(run);
    const output =
      run.output === undefined
        ? { error: run.error }
        : recoveredError
          ? {
              ...(run.output as Record<string, unknown>),
              error: recoveredError,
            }
          : run.output;
    const facts: Record<string, unknown> = {
      branch: agent,
      baseSha,
      commits: run.commits,
      durationMs: run.durationMs,
      ...agentFacts(deps, options, given.prompt, run),
      ...(refs.length ? { refShas } : {}),
      output,
    };
    if (verdict.outcome !== "done")
      return { stage, outcome: verdict.outcome, run: facts };
    const comments = commentsOf(run.output);

    // Take the commits back from the slot, stamp them, and publish the branch.
    const taken = retrieveResult({
      slotClone: slot.dir,
      mainClone: mainDir,
      ref: agent,
      integration,
      defaultBranch: bundle.repo.defaultBranch,
      log,
    });
    if (!taken.fetched)
      throw new InfrastructureError(
        `could not take ${agent} back: ${taken.error ?? "no such branch in the slot"}`,
        billed,
      );
    const stamped = stampTrailers({
      repoDir: mainDir,
      branch: agent,
      before: stampFrom,
      // Origin already has these: this spec's integration branch, the default
      // branch, every other spec/*, and every ticket branch fetched into
      // refs/afk/origin/agent/*. Rewriting them changes hashes and GitHub sees
      // duplicates across PRs.
      exclude: [integration, bundle.repo.defaultBranch],
      excludeGlobs: ["refs/heads/spec/*", "refs/afk/origin/agent/*"],
      ids: {
        spec: bundle.spec.displayId,
        ...(bundle.ticket ? { ticket: bundle.ticket.displayId } : {}),
        run: runIdOf(bundle),
      },
    });
    if (stamped.error)
      throw new InfrastructureError(
        `stamping failed: ${stamped.error}`,
        billed,
      );
    const request = {
      repoDir: mainDir,
      source: `refs/heads/${agent}`,
      target: `refs/heads/${agent}`,
      expectedOld: align.expectedOld,
    };
    // Network blips: wait 10, 30, 90, 180 s and push again from this run, so a flake does not re-run the agent.
    // Each attempt re-checks the job lease first: a worker that lost it must not publish anything.
    const waitSeconds = [10, 30, 90, 180];
    const wait = deps.sleep ?? sleep;
    let pushed: Awaited<ReturnType<PushFn>> = { ok: false, error: "" };
    for (let i = 0; i < waitSeconds.length; i++) {
      if (
        context.signal.aborted ||
        (await deps.api.prePush(context.job)) === "lost"
      ) {
        throw new JobLostError("the lease was lost before the push");
      }
      await assertRemoteUnchanged(
        mainDir,
        agent,
        align.expectedOld,
        context.signal,
        billed,
      );
      pushed = await deps.push(request);
      if (pushed.ok) break;
      if (!isNetworkPushError(pushed.error) || i === waitSeconds.length - 1)
        break;
      await wait(waitSeconds[i] * 1000, context.signal);
    }
    if (!pushed.ok)
      throwPushFailure(
        pushed.error,
        {
          remoteTip: await tipAfterFailedPush(
            mainDir,
            request.target,
            context.signal,
          ),
          startedFrom: align.expectedOld,
        },
        billed,
      );
    facts.headSha = tip(mainDir, agent);
    facts.commits = gitOrThrow(mainDir, [
      "rev-list",
      "--reverse",
      `${stampFrom}..${agent}`,
    ])
      .split("\n")
      .filter(Boolean);
    if (
      RECHECK_TRIGGER_STAGES.has(stage) &&
      typeof facts.headSha === "string"
    ) {
      const incoming = incomingForRecheck(
        stage,
        context,
        mainDir,
        integration,
        bundle.repo.defaultBranch,
      );
      const fromSha = incoming
        ? autoMergeCommit({
            repoDir: mainDir,
            oursSha: before,
            theirsSha: incoming,
            ref: `${RECHECK_REF_PREFIX}${runIdOf(bundle)}`,
          })
        : before;
      facts.recheck = recheckHit({
        repoDir: mainDir,
        fromSha,
        toSha: facts.headSha,
        baselineSha: branchBase(mainDir, integration, agent),
        extraConfigPaths: extraRecheckConfig(mainDir, facts.headSha),
      });
    }
    return {
      stage,
      outcome: "done",
      run: facts,
      ...(comments ? { comments } : {}),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
