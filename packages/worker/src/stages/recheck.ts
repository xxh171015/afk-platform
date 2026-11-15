import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReviewRun,
  git,
  gitOrThrow,
  hasRef,
  promptFor,
  reviewFindings,
  reviewOutputSchemaFor,
  reviewSources,
  writePrompt,
} from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { Slot } from "../slots.ts";
import {
  agentFacts,
  billedFacts,
  branchBase,
  bringBranches,
  type ExecutorDeps,
  InfrastructureError,
  JobLostError,
  publishedTip,
  renderFor,
  runIdOf,
  runOptions,
  type StageContext,
  type StageOutcomeBody,
  snapshotRefs,
  subjectLabel,
  tip,
} from "./common.ts";

function recheckArgs(
  bundle: Bundle,
  payload: Record<string, unknown>,
): { fromSha: string; toSha: string; paths: string[] } | undefined {
  const listed = (
    bundle as Bundle & {
      recheck?: { fromSha: string; toSha: string; paths: string[] } | null;
    }
  ).recheck;
  if (listed?.fromSha && listed.toSha) return listed;
  const fromSha = payload.fromSha;
  const toSha = payload.toSha;
  if (typeof fromSha !== "string" || typeof toSha !== "string")
    return undefined;
  const raw = payload.paths;
  const paths = Array.isArray(raw)
    ? raw.filter((path): path is string => typeof path === "string")
    : [];
  return { fromSha, toSha, paths };
}

// What one axis of a review came to on its own: pass, fix, or the failure that stopped it.
function axisResult(run: Parameters<typeof classifyReviewRun>[0]): string {
  const verdict = classifyReviewRun(run);
  return verdict.kind === "outcome" ? verdict.outcome : "invalid-output";
}

export async function recheck(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle, log } = context;
  const agent = bundle.agentBranch;
  const hit = recheckArgs(bundle, context.job.payload);
  const baseSha =
    hit?.fromSha ??
    branchBase(mainDir, bundle.integrationBranch as string, agent);
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  const reviewed = hasRef(mainDir, `refs/heads/${agent}`)
    ? tip(mainDir, agent)
    : await publishedTip(mainDir, agent, context.signal);
  const branch = `recheck/${subjectLabel(bundle)}`;
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, reviewed]);
  try {
    bringBranches(slot, mainDir, [branch]);
    const ctxDir = await renderFor(deps, context, baseSha, tmp, mainDir);
    if (hit) {
      writeFileSync(
        join(ctxDir, "recheck.json"),
        `${JSON.stringify(hit, null, 2)}\n`,
      );
    }
    const { refs, refShas } = await snapshotRefs(deps, bundle);
    const given = writePrompt(tmp, promptFor("recheck"));
    const options = runOptions(deps, context, "spec");
    const run = await deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
      stage: "recheck",
      branch,
      baseBranch: bundle.integrationBranch as string,
      promptFile: given.promptFile,
      ctxDir,
      refs,
      schema: reviewOutputSchemaFor("spec"),
      ...options,
      signal: context.signal,
    });
    if (context.signal.aborted)
      throw new JobLostError("the lease was lost during Recheck");
    const verdict = classifyReviewRun(run);
    if (verdict.kind === "infrastructure-failure")
      throw new InfrastructureError(verdict.error, billedFacts(run));
    log(
      `recheck: ${verdict.kind === "outcome" ? verdict.outcome : "invalid-output"}`,
    );
    if (run.commits.length > 0)
      log(
        `recheck: WARNING Recheck made ${run.commits.length} commit(s); it should only read`,
      );
    const sources = reviewSources(run.output);
    return {
      stage: "recheck",
      outcome: verdict.kind === "outcome" ? verdict.outcome : "invalid-output",
      run: {
        result: axisResult(run),
        axis: "spec",
        branch: agent,
        baseSha,
        commits: run.commits,
        durationMs: run.durationMs,
        ...agentFacts(deps, options, given.prompt, run),
        ...(refs.length ? { refShas } : {}),
        output: run.output ?? { error: run.error },
        ...(sources ? { sources } : {}),
      },
      findings: run.output ? reviewFindings(run.output) : [],
    };
  } finally {
    git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    rmSync(tmp, { recursive: true, force: true });
  }
}
