import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyLocateRun,
  git,
  gitOrThrow,
  type LocateOutput,
  LocateOutputSchema,
  promptFor,
  writePrompt,
} from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import { withCredentials } from "../credentials.ts";
import { blameLocateFiles } from "../locate.ts";
import {
  agentFacts,
  billedFacts,
  bringBranches,
  type ExecutorDeps,
  InfrastructureError,
  JobLostError,
  NoFreeSlotError,
  renderFor,
  runIdOf,
  runOptions,
  type StageContext,
  type StageOutcomeBody,
  snapshotRefs,
  tip,
} from "./common.ts";

// Locate: every project default branch in one sandbox (workspace + /refs), no
// compose. The agent names one repo; blame of those files yields the original spec.
export async function locateBug(
  rawDeps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const deps = await withCredentials(rawDeps, bundle.repo.url, [
    ...bundle.refs.map((r) => r.url),
    ...(bundle.domain ? [bundle.domain.url] : []),
  ]);
  const defaultBranch = bundle.repo.defaultBranch;
  const mainDir = await deps.repos.ensure(
    bundle.repo.name,
    bundle.repo.url,
    defaultBranch,
  );
  const head = tip(mainDir, defaultBranch);
  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.name,
    repoUrl: bundle.repo.url,
    ref: bundle.agentBranch,
    defaultBranch,
  });
  if (!slot) throw new NoFreeSlotError("no free slot");
  let body: StageOutcomeBody | undefined;
  const tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "afk-ctx-"));
  try {
    const ctxDir = await renderFor(deps, context, head, tmp, mainDir);
    const given = writePrompt(tmp, promptFor("locate-bug"));
    const { refs, refShas } = await snapshotRefs(deps, bundle);
    const options = runOptions(deps, context);
    const branch = bundle.agentBranch;
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, head]);
    try {
      bringBranches(slot, mainDir, [branch]);
      context.log(`locate-bug: running the agent on ${defaultBranch}`);
      const run = await deps.makeAgentRunner(slot.dir, runIdOf(bundle)).run({
        stage: "locate-bug",
        branch,
        baseBranch: defaultBranch,
        promptFile: given.promptFile,
        ctxDir,
        refs,
        schema: LocateOutputSchema,
        ...options,
        signal: context.signal,
      });
      if (context.signal.aborted)
        throw new JobLostError("the lease was lost during locate");
      const verdict = classifyLocateRun(run);
      if (verdict.kind === "infrastructure-failure")
        throw new InfrastructureError(verdict.error, billedFacts(run));
      context.log(
        `locate-bug: ${verdict.outcome}${verdict.detail ? ` (${verdict.detail})` : ""}`,
      );
      if (run.commits.length > 0)
        context.log(
          `locate-bug: WARNING the agent made ${run.commits.length} commit(s); it should only look, and they are dropped`,
        );
      const output: LocateOutput | undefined = run.output;
      const locate = output
        ? {
            repo: output.repo,
            files: output.files,
            evidence: output.evidence,
            reproduction: output.reproduction,
            commits: await blamedLocateCommits(deps, bundle, output),
          }
        : undefined;
      body = {
        stage: "locate-bug",
        outcome: verdict.outcome,
        ...(locate ? { locate } : {}),
        run: {
          branch: defaultBranch,
          headSha: head,
          refShas,
          durationMs: run.durationMs,
          ...agentFacts(deps, options, given.prompt, run),
          output: output ?? { error: run.error },
        },
      };
      return body;
    } finally {
      git(mainDir, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await slot.release(body ? "success" : "failure");
  }
}

async function blamedLocateCommits(
  deps: ExecutorDeps,
  bundle: Bundle,
  output: LocateOutput,
) {
  if (output.files.length === 0) return [];
  const named =
    output.repo === bundle.repo.name
      ? bundle.repo
      : bundle.refs.find((ref) => ref.name === output.repo);
  if (!named) return [];
  const clone = await deps.repos.ensure(
    named.name,
    named.url,
    named.defaultBranch,
  );
  return blameLocateFiles(clone, output.files, named.defaultBranch);
}
