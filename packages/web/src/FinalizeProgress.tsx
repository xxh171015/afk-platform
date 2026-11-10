import { Check } from "lucide-react";
import { Pill } from "./components/afk/badges.tsx";
import {
  type FinalRunRow,
  type FinalStepProgress,
  type FinalStepRow,
  finalizeProgress,
  type RepoFinalProgress,
  runElapsedMs,
} from "./finalize-progress.ts";
import { useNow } from "./hooks/use-now.ts";
import { axisLabel, runResultLabel, stageLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { RunLog } from "./RunLog.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { formatSeconds } from "./time.ts";

// The finishing of each repo on the delivery tab: its steps in order with where it is now, the Runs with how
// long each took (or has been going), and the log of the Run going now, so nobody has to open a Run to follow it.

const repoStatus = {
  queued: { tone: "queued", text: "排队中" },
  running: { tone: "running", text: "进行中" },
  blocked: { tone: "blocked", text: "卡住" },
  done: { tone: "done", text: "已完成" },
} as const;

const stepStatus = {
  waiting: { tone: "neutral", text: "未开始" },
  queued: { tone: "queued", text: "排队中" },
  running: { tone: "running", text: "运行中" },
  blocked: { tone: "blocked", text: "卡住" },
  done: { tone: "done", text: "完成" },
  skipped: { tone: "cancelled", text: "不需要" },
} as const;

const resultText = (result: string | null) =>
  result === null ? "运行中" : (runResultLabel[result] ?? result);

const stageText = (run: FinalRunRow) =>
  `${stageLabel[run.stage] ?? run.stage}${run.axis ? ` · ${axisLabel[run.axis] ?? run.axis}` : ""}`;

export function FinalizeProgress({
  steps,
  runs,
}: {
  steps: readonly FinalStepRow[];
  runs: readonly FinalRunRow[];
}) {
  const repos = finalizeProgress(steps, runs);
  const now = useNow(repos.some((repo) => repo.running.length > 0));
  return (
    <>
      {repos.map((repo) => (
        <RepoCard key={repo.repo} repo={repo} now={now} />
      ))}
    </>
  );
}

function RepoCard({ repo, now }: { repo: RepoFinalProgress; now: number }) {
  const status = repoStatus[repo.status];
  // one finishing job runs per repo at a time; its log carries every review axis
  const live = repo.running.at(-1);
  return (
    <div
      className="mb-3 rounded-md border bg-card p-4"
      data-testid={`delivery-${repo.repo}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-medium">{repo.repo}</h3>
        <Pill tone={status.tone} className="font-sans">
          {status.text}
        </Pill>
      </div>
      <ol
        className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs"
        aria-label={`${repo.repo} 收尾步骤`}
        data-testid={`finalize-steps-${repo.repo}`}
      >
        {repo.steps.map((step, index) => (
          <StepItem key={step.step} step={step} first={index === 0} />
        ))}
      </ol>
      {live ? (
        <div
          className="mb-3 space-y-2"
          data-testid={`finalize-live-${repo.repo}`}
        >
          <p className="text-xs">
            正在运行{" "}
            <a href={paths.run(live.id)} className="font-mono text-primary">
              {live.displayId}
            </a>{" "}
            {stageLabel[live.stage] ?? live.stage}
            {live.startedAt
              ? ` · 已运行 ${formatSeconds(runElapsedMs(live, now))}`
              : ""}
          </p>
          <RunLog runId={live.id} />
        </div>
      ) : null}
      {repo.runs.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="border-b bg-surface text-muted-foreground">
              <tr>
                <th className="p-2.5 font-medium">编号</th>
                <th className="p-2.5 font-medium">步骤</th>
                <th className="p-2.5 font-medium">结果</th>
                <th className="p-2.5 font-medium">耗时</th>
                <th className="p-2.5 font-medium">开始时间</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {repo.runs.map((run) => (
                <tr key={run.id} className="relative hover:bg-accent">
                  <td className="p-2.5">
                    <a
                      href={paths.run(run.id)}
                      className="after:absolute after:inset-0 font-mono text-xs text-primary hover:underline"
                    >
                      {run.displayId}
                    </a>
                  </td>
                  <td className="p-2.5" title={run.stage}>
                    {stageText(run)}
                  </td>
                  <td className="p-2.5" title={run.result ?? "running"}>
                    {resultText(run.result)}
                  </td>
                  <td className="whitespace-nowrap p-2.5">
                    {formatSeconds(runElapsedMs(run, now))}
                  </td>
                  <td className="whitespace-nowrap p-2.5">
                    {run.startedAt ? <RelativeTime iso={run.startedAt} /> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function StepItem({
  step,
  first,
}: {
  step: FinalStepProgress;
  first: boolean;
}) {
  const status = stepStatus[step.status];
  return (
    <li
      className="flex items-center gap-2"
      data-status={step.status}
      data-testid={`finalize-step-${step.step}`}
    >
      {first ? null : (
        <span className="text-muted-foreground" aria-hidden>
          →
        </span>
      )}
      <span
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap",
          step.status === "skipped" || step.status === "waiting"
            ? "text-muted-foreground"
            : "font-medium",
        )}
      >
        {step.status === "done" ? <Check className="size-3.5" /> : null}
        {stageLabel[step.step] ?? step.step}
      </span>
      <Pill tone={status.tone} className="font-sans">
        {step.status === "done" && step.result
          ? resultText(step.result)
          : status.text}
      </Pill>
      {step.blockedReason ? (
        <StatusBadge kind="blocked" code={step.blockedReason} />
      ) : null}
    </li>
  );
}

// Runs that merged the default branch into a spec still in development, shown apart from 收尾 so they
// are not mistaken for finishing steps.
export function UpdateBranchRuns({ runs }: { runs: readonly FinalRunRow[] }) {
  const now = useNow(runs.some((run) => run.result === null));
  const repos = [...new Set(runs.map((run) => run.repo))];
  return (
    <>
      {repos.map((repo) => {
        const ofRepo = runs.filter((run) => run.repo === repo);
        const live = ofRepo.find((run) => run.result === null);
        return (
          <div
            key={repo}
            className="mb-3 rounded-md border bg-card p-4"
            data-testid={`update-branch-${repo}`}
          >
            <h3 className="mb-3 text-sm font-medium">{repo}</h3>
            {live ? (
              <div className="mb-3 space-y-2">
                <p className="text-xs">
                  正在运行{" "}
                  <a
                    href={paths.run(live.id)}
                    className="font-mono text-primary"
                  >
                    {live.displayId}
                  </a>{" "}
                  {stageLabel[live.stage] ?? live.stage}
                  {live.startedAt
                    ? ` · 已运行 ${formatSeconds(runElapsedMs(live, now))}`
                    : ""}
                </p>
                <RunLog runId={live.id} />
              </div>
            ) : null}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="border-b bg-surface text-muted-foreground">
                  <tr>
                    <th className="p-2.5 font-medium">编号</th>
                    <th className="p-2.5 font-medium">步骤</th>
                    <th className="p-2.5 font-medium">结果</th>
                    <th className="p-2.5 font-medium">耗时</th>
                    <th className="p-2.5 font-medium">开始时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ofRepo.map((run) => (
                    <tr key={run.id} className="relative hover:bg-accent">
                      <td className="p-2.5">
                        <a
                          href={paths.run(run.id)}
                          className="after:absolute after:inset-0 font-mono text-xs text-primary hover:underline"
                        >
                          {run.displayId}
                        </a>
                      </td>
                      <td className="p-2.5" title={run.stage}>
                        {stageText(run)}
                      </td>
                      <td className="p-2.5" title={run.result ?? "running"}>
                        {resultText(run.result)}
                      </td>
                      <td className="whitespace-nowrap p-2.5">
                        {formatSeconds(runElapsedMs(run, now))}
                      </td>
                      <td className="whitespace-nowrap p-2.5">
                        {run.startedAt ? (
                          <RelativeTime iso={run.startedAt} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
