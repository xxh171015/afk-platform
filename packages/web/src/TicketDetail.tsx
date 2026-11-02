import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { diffLines } from "diff";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import {
  IdChip,
  Mono,
  ReasonBadge,
  RepoTag,
} from "./components/afk/badges.tsx";
import { Page } from "./components/afk/page.tsx";
import {
  ErrorState,
  RowsSkeleton,
  StaleNotice,
} from "./components/afk/states.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { ticketTypeLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { Markdown } from "./Markdown.tsx";
import { paths } from "./paths.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { RetryNoteField, retryTicketBody } from "./RetryNote.tsx";
import { Sha } from "./Sha.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { StructuredBriefView } from "./StructuredBriefView.tsx";
import { structuredBrief } from "./structured-brief.ts";
import { TicketEdit } from "./TicketEdit.tsx";
import { formatSeconds } from "./time.ts";

export function TicketDetail({ ticketId }: { ticketId: number }) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  const view = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const specId = view.data?.ticket.specId;
  const spec = useQuery({
    queryKey: ["spec", specId],
    enabled: specId !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId as number } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  if (view.isPending) {
    return (
      <Page title="票">
        <p className="sr-only">加载这张票…</p>
        <RowsSkeleton rows={8} />
      </Page>
    );
  }
  if (view.isError && !view.data) {
    return (
      <Page title="票">
        <ErrorState
          error={view.error}
          prefix="无法加载这张票"
          onRetry={() => void view.refetch()}
        />
      </Page>
    );
  }
  const loaded = view.data;
  if (!loaded) return null;
  const {
    ticket,
    versions,
    runs,
    findings,
    gateResults,
    upstream,
    downstream,
    integration,
  } = loaded;

  return (
    <Page
      title={
        <span className="flex flex-wrap items-center gap-2">
          <IdChip id={ticket.id} displayId={ticket.displayId} />
          <span>{ticket.title}</span>
          <StatusBadge kind="ticket" code={ticket.state} />
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Mono title={ticketTypeLabel[ticket.type]}>{ticket.type}</Mono>
          <span>{ticketTypeLabel[ticket.type]}</span>
          <RepoTag name={ticket.repo} />
          <Mono>v{ticket.contentVersion}</Mono>
          <span className="sr-only">
            {ticket.type}, repo {ticket.repo}, version {ticket.contentVersion}
          </span>
        </span>
      }
      actions={<StaleNotice error={view.error} />}
    >
      <nav aria-label="所属需求" className="mb-5 text-xs text-muted-foreground">
        <a href={paths.spec(ticket.specId)} className="hover:text-primary">
          ← 返回所属需求 <Mono>{ticket.specDisplayId}</Mono>
        </a>
      </nav>
      {ticket.brief && ticket.blockedReason ? (
        <section className="mb-6 space-y-3 border-l-2 border-destructive bg-destructive/5 p-4">
          <ReasonBadge reason={ticket.blockedReason} />
          <StructuredBriefView
            brief={structuredBrief(ticket.blockedReason, ticket.brief)}
            runId={ticket.brief.run.id}
            runDisplayId={ticket.brief.run.displayId}
          />
          {ticket.state === "blocked" ? (
            <TicketRetry
              ticketId={ticket.id}
              displayId={ticket.displayId}
              blockedReason={ticket.blockedReason}
            />
          ) : null}
        </section>
      ) : ticket.state === "blocked" ? (
        <TicketRetry
          ticketId={ticket.id}
          displayId={ticket.displayId}
          blockedReason={ticket.blockedReason}
        />
      ) : null}
      {ticket.state === "pending" || ticket.state === "blocked" ? (
        <div className="mb-6">
          <TicketEdit ticketId={ticket.id} file={ticket.file} />
        </div>
      ) : null}

      <div className="grid min-w-0 gap-7 lg:grid-cols-[minmax(0,1fr)_250px]">
        <div className="min-w-0 space-y-7">
          <Markdown source={ticket.body} />
          <section>
            <h2 className="mb-3 text-sm font-semibold">运行</h2>
            {runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">尚无运行记录</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="runs w-full min-w-[520px] text-left text-xs">
                  <thead className="border-b bg-surface text-muted-foreground">
                    <tr>
                      <th className="p-2.5 font-medium">编号</th>
                      <th className="p-2.5 font-medium">阶段</th>
                      <th className="p-2.5 font-medium">结果</th>
                      <th className="p-2.5 font-medium">耗时</th>
                      <th className="p-2.5 font-medium">开始时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {runs.map((run) => (
                      <tr key={run.id} className="relative hover:bg-accent">
                        <td className="p-2.5">
                          <a
                            href={paths.run(run.id)}
                            className="after:absolute after:inset-0 font-mono text-xs text-primary hover:underline"
                          >
                            {run.displayId}
                          </a>
                        </td>
                        <td className="p-2.5">
                          <Mono>
                            {run.stage}
                            {run.axis ? ` (${run.axis})` : ""} #{run.attempt}
                          </Mono>
                        </td>
                        <td className="p-2.5">{run.result ?? "running"}</td>
                        <td className="whitespace-nowrap p-2.5">
                          {formatSeconds(run.durationMs)}
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
            )}
          </section>

          {integration ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold">
                联调 · 已用修复轮 {integration.rounds}/2
              </h2>
              {integration.attempts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  还没有跑过 e2e。
                </p>
              ) : null}
              <ol className="attempts mt-3 space-y-3">
                {integration.attempts.map((attempt) => (
                  <li
                    key={attempt.e2e.id}
                    className="rounded-md border bg-card p-4"
                  >
                    <strong>
                      {attempt.e2e.displayId} {attempt.e2e.result ?? "running"}
                    </strong>
                    {attempt.e2e.testsTotal === null
                      ? ""
                      : `，${attempt.e2e.testsTotal} 个测试中失败 ${attempt.e2e.testsFailed ?? 0} 个`}
                    {attempt.e2e.refShas
                      ? Object.entries(attempt.e2e.refShas).map(
                          ([name, sha]) => (
                            <span key={name}>
                              {`，构建自 ${name}@`}
                              <Sha value={sha} />
                            </span>
                          ),
                        )
                      : ""}
                    {attempt.diagnosis ? (
                      <div className="diagnosis mt-2">
                        诊断：{attempt.diagnosis.failingRepo ?? "未判明仓库"}
                        <pre>{attempt.diagnosis.evidence}</pre>
                        {attempt.diagnosis.failingTests.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            失败用例：
                            {attempt.diagnosis.failingTests.join("、")}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {attempt.fixTicket ? (
                      <p className="text-xs text-muted-foreground">
                        修复票{" "}
                        <a href={paths.ticket(attempt.fixTicket.id)}>
                          {attempt.fixTicket.displayId}
                        </a>{" "}
                        ({attempt.fixTicket.state}, {attempt.fixTicket.repo})
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 text-sm font-semibold">门禁结果</h2>
            {gateResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无门禁结果</p>
            ) : (
              <ul className="gates space-y-3">
                {gateResults.map((gate) => (
                  <li
                    key={gate.commitSha}
                    className="rounded-md border bg-card p-4"
                  >
                    <Sha value={gate.commitSha} />{" "}
                    {gate.testsTotal === null
                      ? "没有 JUnit"
                      : `${gate.testsTotal} 个测试，跳过 ${gate.testsSkipped ?? 0} 个`}
                    <ul>
                      {gate.commandResults.map((step) => {
                        const s = step as { name?: string; exitCode?: number };
                        return (
                          <li key={s.name ?? JSON.stringify(step)}>
                            {`${s.name ?? "command"}: exit ${s.exitCode ?? "?"}`}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold">意见</h2>
            {findings.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无意见</p>
            ) : (
              <ul className="findings space-y-3">
                {findings.map((finding) => (
                  <li key={finding.id} className="space-y-1 text-[13px]">
                    <StatusBadge kind="pr" code={finding.resolution} />
                    {finding.axis ? (
                      <span
                        className={`ml-2 font-mono text-[11px] axis-${finding.axis}`}
                      >
                        {finding.axis}
                      </span>
                    ) : null}{" "}
                    {finding.kind}: {finding.body}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-6 text-[13px] lg:border-l lg:pl-5">
          <section>
            <h2 className="mb-3 text-sm font-semibold">所属需求</h2>
            <p>
              <a href={paths.spec(ticket.specId)}>{ticket.specDisplayId}</a>
              {spec.data?.spec ? ` ${spec.data.spec.title}` : ""}
            </p>
          </section>
          {(
            [
              ["等待", upstream],
              ["挡住", downstream],
            ] as const
          ).map(([heading, related]) => (
            <section key={heading}>
              <h3 className="mb-2 text-xs text-muted-foreground">
                {heading} · {related.length}
              </h3>
              <ul className="related space-y-2">
                {related.map((e) => (
                  <li key={e.id}>
                    <a href={paths.ticket(e.id)}>{e.displayId}</a> ({e.kind},{" "}
                    {e.state})
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {spec.data ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                {ticket.specDisplayId} 的票
              </h3>
              <ul className="related spec-tickets space-y-2">
                {spec.data.tickets.map((t) => (
                  <li key={t.id} className={t.id === ticket.id ? "picked" : ""}>
                    <StatusBadge kind="ticket" code={t.state} />{" "}
                    <a href={paths.ticket(t.id)}>{t.displayId}</a> {t.title}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <VersionHistory ticketId={ticketId} versions={versions} />
        </aside>
      </div>
    </Page>
  );
}

function VersionHistory({
  ticketId,
  versions,
}: {
  ticketId: number;
  versions: { version: number; createdAt: string }[];
}) {
  const api = useApi();
  const [compare, setCompare] = useState(false);
  const [before, setBefore] = useState(String(versions[0]?.version ?? 1));
  const [after, setAfter] = useState(String(versions.at(-1)?.version ?? 1));
  const left = useQuery({
    queryKey: ["ticket", ticketId, "version", before],
    enabled: compare,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: {
          path: { id: ticketId },
          query: { version: Number(before) },
        },
      });
      if (!data) throw new Error(describeError(error));
      return data.ticket;
    },
  });
  const right = useQuery({
    queryKey: ["ticket", ticketId, "version", after],
    enabled: compare,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: {
          path: { id: ticketId },
          query: { version: Number(after) },
        },
      });
      if (!data) throw new Error(describeError(error));
      return data.ticket;
    },
  });
  const diff = (a: string, b: string) =>
    diffLines(a, b).map((part) => (
      <pre
        key={`${part.added ? "+" : part.removed ? "-" : "="}:${part.value}`}
        className={cn(
          "whitespace-pre-wrap break-words p-2 font-mono text-xs",
          part.added
            ? "bg-primary/10 text-primary"
            : part.removed
              ? "bg-destructive/10 text-destructive line-through"
              : "text-muted-foreground",
        )}
      >
        {part.added ? "+ " : part.removed ? "− " : "  "}
        {part.value}
      </pre>
    ));
  const criteria = (list: string[] | undefined) => (list ?? []).join("\n");
  return (
    <section className="border-t pt-4">
      <h2 className="mb-3 text-sm font-semibold">内容版本历史</h2>
      {versions.map((v) => (
        <Button
          key={v.version}
          variant="ghost"
          size="sm"
          className="w-full justify-between px-0 text-xs"
          aria-label={`v${v.version}`}
          onClick={() => {
            const latest = versions.at(-1)?.version ?? v.version;
            if (v.version === latest) {
              setBefore(String(Math.max(1, v.version - 1)));
              setAfter(String(v.version));
            } else {
              setBefore(String(v.version));
              setAfter(String(latest));
            }
            setCompare(true);
          }}
        >
          <Mono>v{v.version}</Mono>
          <span className="text-muted-foreground">
            <RelativeTime iso={v.createdAt} />
          </span>
        </Button>
      ))}
      <Dialog open={compare} onOpenChange={setCompare}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogTitle>内容版本对比</DialogTitle>
          <DialogDescription>删除项为红色，新增项为蓝色。</DialogDescription>
          <div className="flex items-center gap-3">
            <Select value={before} onValueChange={setBefore}>
              <SelectTrigger className="w-32" aria-label="对比版本">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    v{v.version}
                    {v.version === versions.at(-1)?.version ? " · 当前" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={after} onValueChange={setAfter}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={`a-${v.version}`} value={String(v.version)}>
                    v{v.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {right.data ? (
            <>
              <h3 className="text-sm font-semibold">标题</h3>
              {diff(left.data?.title ?? "", right.data.title)}
              <h3 className="text-sm font-semibold">正文</h3>
              {diff(left.data?.body ?? "", right.data.body)}
              <h3 className="text-sm font-semibold">验收标准</h3>
              {diff(
                criteria(left.data?.acceptanceCriteria),
                criteria(right.data.acceptanceCriteria),
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">加载版本…</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TicketRetry({
  ticketId,
  displayId,
  blockedReason,
}: {
  ticketId: number;
  displayId: string;
  blockedReason: string | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const retry = useMutation({
    mutationFn: async (mode: "continue" | "restart") => {
      const { data, error } = await api.POST("/tickets/{id}/retry", {
        params: { path: { id: ticketId } },
        body: retryTicketBody(mode, note),
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] }),
        queryClient.invalidateQueries({ queryKey: ["blocked"] }),
        queryClient.invalidateQueries({ queryKey: ["workbench"] }),
      ]),
  });
  if (blockedReason === "upstream-cancelled") return null;
  const busy = retry.isPending;
  return (
    <div className="ticket-retry space-y-3">
      <RetryNoteField
        id={`retry-note-ticket-${displayId}`}
        value={note}
        onChange={setNote}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => retry.mutate("continue")}
        >
          重试，保留已有工作
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setConfirmRestart(true)}
        >
          <RotateCcw />
          从头重试
        </Button>
      </div>
      {retry.error ? (
        <p className="text-sm text-state-blocked" role="alert">
          {retry.error.message}
        </p>
      ) : null}
      <AlertDialog
        open={confirmRestart}
        onOpenChange={(open) => {
          if (!busy) setConfirmRestart(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从头重试 {displayId}？</AlertDialogTitle>
            <AlertDialogDescription>
              本次重试不会保留已有工作，将重新开始实现。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() =>
                retry.mutate("restart", {
                  onSuccess: () => setConfirmRestart(false),
                })
              }
            >
              确认从头重试
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
