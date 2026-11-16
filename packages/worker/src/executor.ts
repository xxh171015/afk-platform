import {
  alignTicketBranch,
  handbackResumeStage,
  originSha,
  type TicketAlign,
} from "./align-ticket-branch.ts";
import { withCredentials } from "./credentials.ts";
import { cutIntegrationBranch } from "./domain.ts";
import type { Slot } from "./slots.ts";
import {
  bringBranches,
  type ExecutorDeps,
  InfrastructureError,
  NoFreeSlotError,
  type StageContext,
  type StageOutcomeBody,
} from "./stages/common.ts";
import { diagnose } from "./stages/diagnose.ts";
import { e2e } from "./stages/e2e.ts";
import { gate } from "./stages/gate.ts";
import { agentChange } from "./stages/implement.ts";
import { locateBug } from "./stages/locate.ts";
import { merge } from "./stages/merge.ts";
import { recheck } from "./stages/recheck.ts";
import { review } from "./stages/review.ts";

export {
  InfrastructureError,
  isSuccess,
  JobLostError,
  NoFreeSlotError,
} from "./stages/common.ts";
export type { ExecutorDeps, StageContext, StageOutcomeBody };

// Runs one stage of one ticket and returns the facts for the API: what the worker is for. Which stage comes next,
// and whether the ticket is blocked, is the API's decision (docs/specs/m1-platform.md「谁决定下一步」).

export async function executeStage(
  rawDeps: ExecutorDeps,
  context: StageContext,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  if (bundle.job.stage === "locate-bug") return locateBug(rawDeps, context);
  // the repos a stage reads besides its own are fetched with tokens of their own
  const deps = await withCredentials(rawDeps, bundle.repo.url, [
    ...bundle.contracts.map((c) => c.url),
    ...bundle.refs.map((r) => r.url),
    ...bundle.environment.map((r) => r.url),
    ...(bundle.domain ? [bundle.domain.url] : []),
  ]);
  if (!bundle.integrationBranch)
    throw new InfrastructureError(
      "the spec has no integration branch for this repo",
    );
  const mainDir = await deps.repos.ensure(
    bundle.repo.name,
    bundle.repo.url,
    bundle.repo.defaultBranch,
  );
  try {
    await cutIntegrationBranch(
      deps.repos,
      deps.push,
      mainDir,
      bundle,
      context.log,
    );
  } catch (error) {
    throw new InfrastructureError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const slot = await deps.slots.acquire({
    jobId: context.job.id,
    attempt: context.job.attempt,
    repo: bundle.repo.name,
    repoUrl: bundle.repo.url,
    ref: bundle.agentBranch,
    integration: bundle.integrationBranch as string,
    defaultBranch: bundle.repo.defaultBranch,
  });
  if (!slot) throw new NoFreeSlotError("no free slot");
  let body: StageOutcomeBody | undefined;
  try {
    body = await runStage(deps, context, mainDir, slot);
    return body;
  } finally {
    // Any stage that ran to an answer leaves a clean slot, whatever the answer; a clone is kept only when the stage broke.
    await slot.release(body ? "success" : "failure");
  }
}

const SKIP_TICKET_ALIGN = new Set([
  "e2e",
  "diagnose",
  "final-review",
  "recheck",
]);

function withOrphanRun(
  body: StageOutcomeBody,
  align: TicketAlign,
): StageOutcomeBody {
  if (!align.orphan) return body;
  const run =
    body.run && typeof body.run === "object" && !Array.isArray(body.run)
      ? (body.run as Record<string, unknown>)
      : {};
  return { ...body, run: { ...run, ...align.orphan } };
}

function attachOrphan(error: unknown, align: TicketAlign): void {
  if (!(error instanceof InfrastructureError) || !align.orphan) return;
  error.orphanRef = align.orphan.orphanRef;
  error.orphanSha = align.orphan.orphanSha;
}

async function runStage(
  deps: ExecutorDeps,
  context: StageContext,
  mainDir: string,
  slot: Slot,
): Promise<StageOutcomeBody> {
  const { bundle } = context;
  const integration = bundle.integrationBranch as string;
  const restart =
    bundle.job.stage === "implement" && bundle.ticket?.restart === true;
  const align = SKIP_TICKET_ALIGN.has(bundle.job.stage)
    ? { expectedOld: "" }
    : await alignTicketBranch(mainDir, bundle.agentBranch, {
        restart,
        signal: context.signal,
      });
  if (restart)
    context.log(
      `restart: dropped ${bundle.agentBranch}${align.remoteTip ? ` (origin was ${align.remoteTip})` : ""}`,
    );
  context.align = align;
  if (align.orphan)
    context.log(
      `align: ${bundle.agentBranch} follows origin ${align.remoteTip}; kept ${align.orphan.orphanSha} at ${align.orphan.orphanRef}`,
    );
  bringBranches(slot, mainDir, [integration, bundle.agentBranch]);
  try {
    let body: StageOutcomeBody;
    if (
      bundle.handbackResolve &&
      bundle.job.stage === "implement" &&
      bundle.ticket
    ) {
      const resume = await handbackResumeStage(
        mainDir,
        bundle.agentBranch,
        integration,
        bundle.ticket.type,
        { signal: context.signal },
      );
      const remote =
        align.remoteTip ??
        (await originSha(mainDir, bundle.agentBranch, {
          signal: context.signal,
        }));
      context.log(
        `handback: resume from ${resume} (origin ${remote ?? "none"})`,
      );
      body = {
        stage: "implement",
        outcome: "handback-resolved",
        handback: { resumeStage: resume },
        run: {
          branch: bundle.agentBranch,
          ...(remote ? { headSha: remote } : {}),
        },
      };
    } else {
      switch (bundle.job.stage) {
        case "implement":
        case "gate-fix":
        case "review-fix":
        case "merge-fix":
        case "final-fix":
        case "final-tidy":
          body = await agentChange(deps, context, mainDir, slot, align);
          break;
        case "review":
        case "final-review":
          body = await review(deps, context, mainDir, slot);
          break;
        case "recheck":
          body = await recheck(deps, context, mainDir, slot);
          break;
        case "gate":
          body = await gate(deps, context, mainDir, slot);
          break;
        case "merge":
        case "final-merge":
        case "tidy-merge":
          body = await merge(deps, context, mainDir, slot, align);
          break;
        case "update-branch":
          body =
            context.job.type === "agent-run"
              ? await agentChange(deps, context, mainDir, slot, align)
              : await merge(deps, context, mainDir, slot, align);
          break;
        case "e2e":
          body = await e2e(deps, context, mainDir, slot);
          break;
        case "diagnose":
          body = await diagnose(deps, context, mainDir, slot);
          break;
        default:
          throw new InfrastructureError(`unknown stage ${bundle.job.stage}`);
      }
    }
    return withOrphanRun(body, context.align ?? align);
  } catch (error) {
    attachOrphan(error, context.align ?? align);
    throw error;
  }
}
