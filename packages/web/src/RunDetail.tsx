import { DECISION_KIND_LABELS, decisionsOf } from "@afk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Mono, ShaChip } from "./components/afk/badges.tsx";
import { JsonTree } from "./components/afk/json-tree.tsx";
import { Page } from "./components/afk/page.tsx";
import {
  EmptyState,
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { commitHtmlUrl } from "./host-links.ts";
import { runResultLabel, stageLabel } from "./lib/labels.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { Markdown } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { RunLog } from "./RunLog.tsx";
import { formatDuration, formatSeconds } from "./time.ts";
import { formatTokens, tokenCounts } from "./token-usage.ts";

function usageLabel(usage: unknown): string {
  const counts = tokenCounts(usage);
  const parts = [
    counts.inputTokens !== undefined
      ? `输入 ${formatTokens(counts.inputTokens)}`
      : null,
    counts.outputTokens !== undefined
      ? `输出 ${formatTokens(counts.outputTokens)}`
      : null,
    counts.cacheReadTokens !== undefined
      ? `缓存读 ${formatTokens(counts.cacheReadTokens)}`
      : null,
    counts.cacheWriteTokens !== undefined
      ? `缓存写 ${formatTokens(counts.cacheWriteTokens)}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function RunDetail({
  runId,
  logPollMs,
}: {
  runId: number;
  logPollMs?: number;
}) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  const [tab, setTab] = useState("prompt");
  const view = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const { data, error } = await api.GET("/runs/{id}", {
        params: { path: { id: runId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  if (view.isPending) {
    return (
      <Page title="Run">
        <p className="sr-only">加载这次运行…</p>
        <RowsSkeleton rows={8} />
      </Page>
    );
  }
  if (view.isError && !view.data) {
    return (
      <Page title="Run">
        <ErrorState
          error={view.error}
          prefix="无法加载这次运行"
          onRetry={() => void view.refetch()}
        />
      </Page>
    );
  }
  const run = view.data;
  if (!run) return null;

  const result = run.result ?? "running";
  const duration = formatDuration(run.durationMs);
  const commits = run.commits ?? [];
  const contractEntries = run.contractShas
    ? Object.entries(run.contractShas)
    : [];
  const refEntries = run.refShas ? Object.entries(run.refShas) : [];
  const decisions = decisionsOf(run.output);

  return (
    <Page
      title={`${run.displayId} · ${run.ticketDisplayId ?? run.specDisplayId} · ${stageLabel[run.stage] ?? run.stage} · 第 ${run.attempt} 次 · ${runResultLabel[result] ?? result} · ${duration}`}
      actions={<StaleNotice error={view.error} />}
    >
      <div className="mb-5 flex flex-wrap gap-5 text-sm">
        {run.ticketId ? (
          <a
            href={paths.ticket(run.ticketId)}
            className="text-primary hover:underline"
          >
            {run.ticketDisplayId}
          </a>
        ) : null}
        <a
          href={paths.spec(run.specId)}
          className="text-primary hover:underline"
        >
          {run.specDisplayId}
        </a>
      </div>
      <dl className="mb-7 flex flex-wrap gap-x-6 gap-y-4 border-y py-4 text-xs">
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">阶段</dt>
          <dd>
            <Mono title={stageLabel[run.stage]}>{run.stage}</Mono>
            {run.axis ? ` (${run.axis})` : ""}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">次数</dt>
          <dd>{run.attempt}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">结果</dt>
          <dd>
            <Mono>{result}</Mono>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">耗时</dt>
          <dd>{formatSeconds(run.durationMs)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">API 耗时</dt>
          <dd>{formatSeconds(run.durationApiMs ?? null)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">CLI 版本</dt>
          <dd>
            <Mono>{run.cursorCliVersion ?? "—"}</Mono>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">用量</dt>
          <dd data-testid="run-usage">{usageLabel(run.tokenUsage)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">模型</dt>
          <dd>
            <Mono>{run.model ?? "—"}</Mono>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">skills SHA</dt>
          <dd>
            <ShaChip sha={run.skillsSha ?? null} />
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-muted-foreground">契约 SHA</dt>
          <dd className="flex flex-wrap gap-2">
            {contractEntries.length
              ? contractEntries.map(([repo, sha]) => (
                  <span key={repo} className="flex items-center gap-2">
                    <Mono>{repo}</Mono>
                    <ShaChip
                      sha={sha}
                      href={
                        run.repoUrl ? commitHtmlUrl(run.repoUrl, sha) : null
                      }
                    />
                  </span>
                ))
              : "—"}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted-foreground">refs SHA</dt>
          <dd className="flex flex-wrap gap-2">
            {refEntries.length
              ? refEntries.map(([repo, sha]) => (
                  <span key={repo} className="flex items-center gap-2">
                    <Mono>{repo}</Mono>
                    <ShaChip
                      sha={sha}
                      href={
                        run.repoUrl ? commitHtmlUrl(run.repoUrl, sha) : null
                      }
                    />
                  </span>
                ))
              : "—"}
          </dd>
        </div>
      </dl>
      {decisions.length > 0 ? (
        <section className="mt-5">
          <h2 className="mb-2 text-sm font-medium">决定</h2>
          <ul className="decisions space-y-1 text-sm">
            {decisions.map((item) => (
              <li key={`${item.kind}-${item.text}`}>
                <span className="text-muted-foreground">
                  {DECISION_KIND_LABELS[item.kind]}
                </span>{" "}
                {item.text}
                {item.ref ? ` (${item.ref})` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <RunLog runId={runId} pollMs={logPollMs} durationMs={run.durationMs} />
      <Tabs value={tab} onValueChange={setTab} className="mt-7">
        <TabsList>
          <TabsTrigger value="prompt" onClick={() => setTab("prompt")}>
            提示词
          </TabsTrigger>
          <TabsTrigger value="output" onClick={() => setTab("output")}>
            结构化输出
          </TabsTrigger>
          <TabsTrigger value="commits" onClick={() => setTab("commits")}>
            提交
          </TabsTrigger>
        </TabsList>
        <TabsContent value="prompt">
          {run.prompt ? (
            <div className="py-4">
              <Markdown source={run.prompt} contents />
            </div>
          ) : (
            <EmptyState title="没有提示词" />
          )}
        </TabsContent>
        <TabsContent value="output">
          {run.output == null ? (
            <EmptyState title="没有结构化输出" />
          ) : (
            <div className="overflow-x-auto py-4">
              <JsonTree value={run.output} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="commits">
          {commits.length ? (
            <ul className="divide-y">
              {commits.map((sha) => (
                <li key={sha} className="flex items-start gap-3 py-4 text-sm">
                  <ShaChip
                    sha={sha}
                    href={run.repoUrl ? commitHtmlUrl(run.repoUrl, sha) : null}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="没有提交记录" />
          )}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
