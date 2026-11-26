import type { paths } from "@afk/shared";
import {
  changeRequestBlockedMessage,
  type StaleReviewDraft,
  staleChangeRequestPrompt,
} from "@afk/shared";
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { ErrorState, RowsSkeleton } from "./components/afk/states.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { cn } from "./lib/utils.ts";
import { DETAIL_POLL_MS } from "./live.ts";
import { firstCommentLine, ReviewDiff } from "./ReviewDiff.tsx";
import { ReviewRail } from "./ReviewRail.tsx";
import {
  defaultFileOpen,
  fileMatches,
  groupByTicket,
  omittedReason,
  pullsInMergeOrder,
  type ReviewFileView,
  ticketsOf,
} from "./review-model.ts";
import {
  parseReviewQuery,
  type ReviewFlag,
  type ReviewSearch,
  reviewHref,
  reviewSearch,
  reviewViewOf,
  serializeReviewQuery,
} from "./review-search.ts";
import { isTypingTarget, reviewShortcutFromKey } from "./shortcuts.ts";
import { shortSha } from "./status.ts";

type SpecReview =
  paths["/specs/{id}/review"]["get"]["responses"][200]["content"]["application/json"];
type ReviewRevision =
  paths["/pull-requests/{id}/review-revision"]["get"]["responses"][200]["content"]["application/json"];
type ReviewComment =
  paths["/pull-requests/{id}/review-comments"]["get"]["responses"][200]["content"]["application/json"]["comments"][number];

type ComposeDraft = {
  commentId?: number;
  path: string | null;
  side: "old" | "new" | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerpt: string | null;
  body: string;
};

const FILTERS: { flag: ReviewFlag; label: string }[] = [
  { flag: "unviewed", label: "未看" },
  { flag: "commented", label: "有意见" },
  { flag: "drafts", label: "有草稿" },
  { flag: "since", label: "上次审后改过" },
  { flag: "added", label: "新增" },
  { flag: "deleted", label: "删除" },
  { flag: "renamed", label: "改名" },
  { flag: "tests", label: "只看测试" },
  { flag: "hide-generated", label: "隐藏生成文件" },
];

type ReadyRevision = Extract<ReviewRevision, { state: "ready" }>;

function asFiles(files: ReadyRevision["files"]): ReviewFileView[] {
  return files.map((file) => ({
    ...file,
    attributions: file.attributions.map((item) => ({
      ticket: "ticket" in item ? item.ticket : undefined,
      run: "run" in item ? item.run : undefined,
      kind: "kind" in item ? item.kind : undefined,
    })),
  }));
}

export function ReviewPage({ specId }: { specId: number }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  const rawSearch = useRouterState({ select: (s) => s.location.search });
  const search = reviewSearch(rawSearch);
  const view = reviewViewOf(search);
  const query = parseReviewQuery(search.q);
  const filterRef = useRef<HTMLInputElement>(null);
  const [groupBy, setGroupBy] = useState<"dir" | "ticket">("dir");
  const [highlightTicket, setHighlightTicket] = useState<string | null>(null);
  const [hunkIndex, setHunkIndex] = useState(0);
  const [pin, setPin] = useState<{ pullId: number; head: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState(query.path);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [cursor, setCursor] = useState<{
    path: string;
    side: "old" | "new";
    line: number;
    excerpt: string;
  } | null>(null);

  const specReview = useQuery({
    queryKey: ["spec", specId, "review"],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}/review", {
        params: { path: { id: specId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  const pulls = pullsInMergeOrder(
    specReview.data?.pullRequests ?? [],
    specReview.data?.acceptancePack?.mergeOrder?.ordered ?? [],
    specReview.data?.acceptancePack?.mergeOrder?.unordered ?? [],
  );
  const pull = pulls.find((item) => item.id === search.pr) ?? pulls[0] ?? null;
  const pinnedHead =
    pin && pull && pin.pullId === pull.id ? pin.head : (pull?.headSha ?? null);

  useEffect(() => {
    if (!pull) return;
    setPin((current) =>
      current?.pullId === pull.id
        ? current
        : { pullId: pull.id, head: pull.headSha },
    );
  }, [pull]);

  useEffect(() => {
    setPathDraft(query.path);
  }, [query.path]);

  const revision = useQuery({
    queryKey: ["review-revision", pull?.id, pinnedHead],
    enabled: pull != null && Boolean(pinnedHead),
    queryFn: async () => {
      const { data, error } = await api.GET(
        "/pull-requests/{id}/review-revision",
        {
          params: {
            path: { id: pull?.id as number },
            query: { head: pinnedHead as string },
          },
        },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  const ready = revision.data?.state === "ready" ? revision.data : null;
  const files = ready ? asFiles(ready.files) : [];
  const comments = useQuery({
    queryKey: ["review-comments", pull?.id],
    enabled: pull != null,
    queryFn: async () => {
      const { data, error } = await api.GET(
        "/pull-requests/{id}/review-comments",
        { params: { path: { id: pull?.id as number } } },
      );
      if (!data) throw new Error(describeError(error));
      return data.comments;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const commentList = comments.data ?? [];
  const commentFlags = {
    commented: new Set(
      commentList
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path)),
    ),
    drafts: new Set(
      commentList
        .filter((item) => item.state === "draft")
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path)),
    ),
  };
  const canWrite = specReview.data?.spec.state === "awaiting-review";
  const draftCount = commentList.filter(
    (item) => item.state === "draft",
  ).length;

  const sinceQueries = useQueries({
    queries:
      query.since && ready
        ? files.map((file) => ({
            queryKey: ["review-file", file.id, "since-flag"],
            queryFn: async () => {
              const { data } = await api.GET("/review-files/{id}", {
                params: {
                  path: { id: file.id },
                  query: { view: "since" },
                },
              });
              return {
                id: file.id,
                changed: Boolean(data?.patch),
              };
            },
          }))
        : [],
  });
  const sinceChanged = new Set(
    sinceQueries
      .map((item) => item.data)
      .filter((item): item is { id: number; changed: boolean } =>
        Boolean(item?.changed),
      )
      .map((item) => item.id),
  );

  const visible = files.filter((file) =>
    fileMatches(file, query, sinceChanged, commentFlags),
  );
  const selectedPath = useMemo(() => {
    if (search.file && visible.some((file) => file.path === search.file)) {
      return search.file;
    }
    return (
      visible.find((file) => !file.lockfile && !file.generated)?.path ??
      visible[0]?.path
    );
  }, [search.file, visible]);
  const selected = files.find((file) => file.path === selectedPath);

  const patchView = view === "since" ? "since" : "all";
  const openFiles = visible.filter(
    (file) => view !== "guide" && defaultFileOpen(file, selectedPath),
  );
  const patchQueries = useQueries({
    queries:
      view === "guide"
        ? []
        : openFiles.map((file) => ({
            queryKey: ["review-file", file.id, patchView],
            queryFn: async () => {
              const { data, error } = await api.GET("/review-files/{id}", {
                params: {
                  path: { id: file.id },
                  query: { view: patchView },
                },
              });
              if (!data) throw new Error(describeError(error));
              return data;
            },
          })),
  });
  const patches = new Map(
    openFiles.map(
      (file, index) => [file.id, patchQueries[index]?.data] as const,
    ),
  );

  const setSearch = (next: ReviewSearch) => {
    router.history.push(reviewHref(specId, next));
  };

  const viewed = useMutation({
    mutationFn: async (file: ReviewFileView) => {
      if (!pull) throw new Error("no pull request");
      const call = file.viewed ? api.DELETE : api.PUT;
      const { data, error } = await call(
        "/pull-requests/{id}/viewed-files/{path}",
        {
          params: { path: { id: pull.id, path: file.path } },
          body: { newBlob: file.newBlob },
        },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["spec", specId, "review"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["review-revision", pull?.id, pinnedHead],
      });
    },
  });

  const invalidateComments = () => {
    void queryClient.invalidateQueries({
      queryKey: ["review-comments", pull?.id],
    });
    void queryClient.invalidateQueries({
      queryKey: ["spec", specId, "review"],
    });
  };

  const saveComment = useMutation({
    mutationFn: async (draft: ComposeDraft) => {
      if (!pull || ready == null) throw new Error("no pull request");
      if (draft.commentId != null) {
        const { data, error } = await api.PATCH("/review-comments/{id}", {
          params: { path: { id: draft.commentId } },
          body: { body: draft.body },
        });
        if (!data) throw new Error(describeError(error));
        return data;
      }
      const { data, error } = await api.POST(
        "/pull-requests/{id}/review-comments",
        {
          params: { path: { id: pull.id } },
          body: {
            revisionId: ready.id,
            path: draft.path,
            side: draft.side,
            lineStart: draft.lineStart,
            lineEnd: draft.lineEnd,
            excerpt: draft.excerpt,
            body: draft.body,
          },
        },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => {
      setCompose(null);
      invalidateComments();
    },
  });

  const removeComment = useMutation({
    mutationFn: async (id: number) => {
      const { data, error } = await api.DELETE("/review-comments/{id}", {
        params: { path: { id } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => {
      setCompose(null);
      invalidateComments();
    },
  });

  const submitChangeRequest = useMutation({
    mutationFn: async (acknowledgeStale: boolean) => {
      const { data, error } = await api.POST("/specs/{id}/change-requests", {
        params: { path: { id: specId } },
        body: { acknowledgeStale },
      });
      if (data) return { ok: true as const };
      const stale = staleDraftsOf(error);
      if (!acknowledgeStale && stale) return { ok: false as const, stale };
      throw new Error(describeError(error));
    },
    onSuccess: (result) => {
      if (!result.ok) {
        if (window.confirm(staleChangeRequestPrompt(result.stale))) {
          submitChangeRequest.mutate(true);
        }
        return;
      }
      setNote(null);
      invalidateComments();
      void queryClient.invalidateQueries({ queryKey: ["spec", specId] });
    },
    onError: (err) => {
      setNote(err instanceof Error ? err.message : describeError(err));
    },
  });

  const openLineCompose = (input: {
    path: string;
    side: "old" | "new";
    line: number;
    excerpt: string;
  }) => {
    setCursor(input);
    setCompose({
      path: input.path,
      side: input.side,
      lineStart: input.line,
      lineEnd: input.line,
      excerpt: input.excerpt,
      body: "",
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const shortcut = reviewShortcutFromKey(event);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.type === "focus-filter") {
        filterRef.current?.focus();
        return;
      }
      if (shortcut.type === "comment") {
        if (!canWrite) return;
        if (cursor && cursor.path === selectedPath) {
          openLineCompose(cursor);
          return;
        }
        if (selected) {
          const fromHunk = firstCommentLine(
            patches.get(selected.id)?.patch ?? null,
            hunkIndex,
          );
          if (fromHunk) {
            openLineCompose({ path: selected.path, ...fromHunk });
            return;
          }
          setCompose({
            path: selected.path,
            side: null,
            lineStart: null,
            lineEnd: null,
            excerpt: null,
            body: "",
          });
          return;
        }
        setCompose({
          path: null,
          side: null,
          lineStart: null,
          lineEnd: null,
          excerpt: null,
          body: "",
        });
      }
      if (shortcut.type === "next-file" || shortcut.type === "prev-file") {
        if (visible.length === 0) return;
        const at = visible.findIndex((file) => file.path === selectedPath);
        const delta = shortcut.type === "next-file" ? 1 : -1;
        const next = visible[(at + delta + visible.length) % visible.length];
        if (next) {
          setSearch({
            ...search,
            file: next.path,
            view: view === "guide" ? "all" : view,
          });
          setHunkIndex(0);
        }
        return;
      }
      if (shortcut.type === "toggle-viewed" && selected) {
        viewed.mutate(selected);
        return;
      }
      if (shortcut.type === "next-hunk" || shortcut.type === "prev-hunk") {
        const patch = selected ? patches.get(selected.id)?.patch : null;
        const count = selected
          ? parsePatchCount(patch) || selected.hunks?.length || 0
          : 0;
        if (count === 0) return;
        setHunkIndex(
          (current) =>
            (current + (shortcut.type === "next-hunk" ? 1 : -1) + count) %
            count,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (specReview.isPending) {
    return (
      <div>
        <p className="sr-only">加载审查页…</p>
        <RowsSkeleton rows={8} />
      </div>
    );
  }
  if (specReview.isError && !specReview.data) {
    return (
      <ErrorState
        error={specReview.error}
        prefix="无法加载审查"
        onRetry={() => void specReview.refetch()}
      />
    );
  }
  const review = specReview.data;
  if (!review) return null;
  const blocked = changeRequestBlockedMessage(
    review.spec.state,
    review.spec.displayId,
  );
  if (pulls.length === 0) {
    return (
      <div data-testid="review-page">
        <p className="note">还没有 PR</p>
      </div>
    );
  }

  const latestHead = pull?.headSha ?? null;
  const newer =
    pinnedHead && latestHead && pinnedHead !== latestHead ? latestHead : null;
  const complete = pull?.revision.complete ?? ready?.complete ?? true;
  const viewedCount = pull?.revision.viewedCount ?? 0;
  const filesCount = pull?.revision.filesCount ?? files.length;
  const groups =
    groupBy === "ticket"
      ? groupByTicket(
          visible,
          review.tickets.map((ticket) => ticket.displayId),
        )
      : [{ ticket: null, files: visible }];

  return (
    <div data-testid="review-page" className="space-y-4">
      {!complete ? (
        <p role="status" className="error">
          这份 diff 不完整
        </p>
      ) : null}
      {newer ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 border-l-2 border-primary bg-primary/5 px-3 py-2 text-sm"
        >
          PR 有新提交：切换到 {shortSha(newer)}
          <button
            type="button"
            className="text-primary underline"
            onClick={() => {
              if (pull) setPin({ pullId: pull.id, head: newer });
            }}
          >
            切换
          </button>
        </p>
      ) : null}
      {revision.data?.state === "pending" ? (
        <p className="note">正在计算这份审查版本…</p>
      ) : null}
      {revision.data?.state === "failed" ? (
        <p className="error">
          计算失败{revision.data.error ? `：${revision.data.error}` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          选择 PR
          <select
            aria-label="选择 PR"
            className="rounded-md border bg-background px-2 py-1"
            value={pull?.id ?? ""}
            onChange={(event) => {
              setHighlightTicket(null);
              setSearch({
                ...search,
                pr: Number(event.target.value),
                file: undefined,
              });
            }}
          >
            {pulls.map((item) => (
              <option key={item.id} value={item.id}>
                {item.repo} #{item.number}
              </option>
            ))}
          </select>
        </label>
        {pinnedHead ? (
          <span data-testid="review-head">{shortSha(pinnedHead)}</span>
        ) : null}
        <span>
          已看 {viewedCount}/{filesCount}
        </span>
        {query.path ||
        query.unviewed ||
        query.commented ||
        query.drafts ||
        query.since ||
        query.added ||
        query.deleted ||
        query.renamed ||
        query.tests ||
        query["hide-generated"] ||
        query.tickets.length > 0 ? (
          <span>当前显示 {visible.length} 个</span>
        ) : null}
        <div className="flex gap-1">
          {(
            [
              ["guide", "导读"],
              ["all", "全部变更"],
              ["since", "上次审后"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                view === id ? "bg-accent font-medium" : "text-muted-foreground",
              )}
              onClick={() => setSearch({ ...search, view: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs"
          disabled={submitChangeRequest.isPending}
          onClick={() => submitChangeRequest.mutate(false)}
        >
          {draftCount > 0 ? `提交修改要求（${draftCount}）` : "提交修改要求"}
        </button>
        {blocked ? <span className="error text-xs">{blocked}</span> : null}
        {note ? (
          <span role="status" className="error text-xs">
            {note}
          </span>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-primary underline"
            onClick={() =>
              setCompose({
                path: null,
                side: null,
                lineStart: null,
                lineEnd: null,
                excerpt: null,
                body: "",
              })
            }
          >
            写 PR 意见
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input
          ref={filterRef}
          aria-label="过滤路径"
          placeholder="过滤路径，支持 *"
          value={pathDraft}
          onChange={(event) => {
            const path = event.target.value;
            setPathDraft(path);
            setSearch({
              ...search,
              q: serializeReviewQuery({ ...query, path }),
            });
          }}
          className="h-8 w-56 rounded-md border bg-background px-2 text-sm"
        />
        {FILTERS.map((item) => (
          <label key={item.flag} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={query[item.flag]}
              onChange={() => {
                setSearch({
                  ...search,
                  q: serializeReviewQuery({
                    ...query,
                    [item.flag]: !query[item.flag],
                  }),
                });
              }}
            />
            {item.label}
          </label>
        ))}
        {review.tickets.map((ticket) => (
          <label key={ticket.id} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={query.tickets.includes(ticket.displayId)}
              onChange={() => {
                const have = query.tickets.includes(ticket.displayId);
                setSearch({
                  ...search,
                  q: serializeReviewQuery({
                    ...query,
                    tickets: have
                      ? query.tickets.filter((id) => id !== ticket.displayId)
                      : [...query.tickets, ticket.displayId],
                  }),
                });
              }}
            />
            {ticket.displayId}
          </label>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-2">
          <div className="flex gap-1">
            <button
              type="button"
              aria-pressed={groupBy === "dir"}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                groupBy === "dir" ? "bg-accent" : "text-muted-foreground",
              )}
              onClick={() => {
                setGroupBy("dir");
                setHighlightTicket(null);
              }}
            >
              按目录
            </button>
            <button
              type="button"
              aria-pressed={groupBy === "ticket"}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                groupBy === "ticket" ? "bg-accent" : "text-muted-foreground",
              )}
              onClick={() => setGroupBy("ticket")}
            >
              按票
            </button>
          </div>
          <ul className="space-y-2 text-sm">
            {groupBy === "ticket" ? (
              groups.map((group) => (
                <li
                  key={group.ticket ?? "none"}
                  data-testid={`review-ticket-${group.ticket ?? "none"}`}
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {group.ticket ?? "未归属"}
                  </p>
                  <FileList
                    files={group.files}
                    selectedPath={selectedPath}
                    onPick={(path) => {
                      setHighlightTicket(group.ticket);
                      setHunkIndex(0);
                      setSearch({
                        ...search,
                        file: path,
                        view: view === "guide" ? "all" : view,
                      });
                    }}
                  />
                </li>
              ))
            ) : (
              <FileList
                files={visible}
                selectedPath={selectedPath}
                onPick={(path) => {
                  setHighlightTicket(null);
                  setHunkIndex(0);
                  setSearch({
                    ...search,
                    file: path,
                    view: view === "guide" ? "all" : view,
                  });
                }}
              />
            )}
          </ul>
        </div>
        <div className="min-w-0 space-y-3">
          {compose && canWrite ? (
            <form
              className="space-y-2 rounded-md border bg-surface p-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                if (compose.body.trim() === "") return;
                saveComment.mutate(compose);
              }}
            >
              <p>
                {compose.commentId != null
                  ? `编辑 ${formatCommentId(compose.commentId, commentList)}`
                  : compose.path == null
                    ? "写 PR 意见"
                    : compose.lineStart == null
                      ? `写文件意见 ${compose.path}`
                      : `写意见 ${compose.path} 第 ${compose.lineStart} 行`}
              </p>
              <textarea
                aria-label="人审意见"
                className="h-24 w-full rounded-md border bg-background px-2 py-1"
                value={compose.body}
                onChange={(event) =>
                  setCompose({ ...compose, body: event.target.value })
                }
              />
              <div className="flex gap-2">
                <button type="submit" className="text-primary underline">
                  保存草稿
                </button>
                <button type="button" onClick={() => setCompose(null)}>
                  取消
                </button>
              </div>
            </form>
          ) : null}
          {view === "guide" ? (
            <p className="note">导读还没有正文</p>
          ) : view === "since" ? (
            <p className="note">
              与上次审查版本对照；若中间合过默认分支，会含那些改动。
            </p>
          ) : null}
          {view !== "guide"
            ? visible.map((file) => {
                const open = defaultFileOpen(file, selectedPath);
                if (!open) {
                  return (
                    <article
                      key={file.id}
                      className="overflow-hidden rounded-md border"
                    >
                      <header className="flex flex-wrap items-center gap-2 border-b bg-surface px-3 py-2 text-sm">
                        <strong>{file.path}</strong>
                        <span className="text-xs text-muted-foreground">
                          +{file.additions} −{file.deletions} · 已折叠
                        </span>
                        <button
                          type="button"
                          className="text-xs text-primary underline"
                          onClick={() =>
                            setSearch({
                              ...search,
                              file: file.path,
                              view,
                            })
                          }
                        >
                          展开
                        </button>
                      </header>
                    </article>
                  );
                }
                const patch = patches.get(file.id);
                return (
                  <article
                    key={file.id}
                    className="overflow-hidden rounded-md border"
                  >
                    <header className="flex flex-wrap items-center gap-2 border-b bg-surface px-3 py-2 text-sm">
                      <strong>{file.path}</strong>
                      <span className="text-xs text-muted-foreground">
                        +{file.additions} −{file.deletions}
                        {file.viewed ? " · 已看" : ""}
                        {ticketsOf(file).length > 0
                          ? ` · ${ticketsOf(file).join(" ")}`
                          : ""}
                      </span>
                      {canWrite ? (
                        <button
                          type="button"
                          className="text-xs text-primary underline"
                          onClick={() =>
                            setCompose({
                              path: file.path,
                              side: null,
                              lineStart: null,
                              lineEnd: null,
                              excerpt: null,
                              body: "",
                            })
                          }
                        >
                          写文件意见 {file.path}
                        </button>
                      ) : null}
                    </header>
                    {file.patchOmitted ? (
                      <p className="note px-3 py-2 text-sm">
                        {omittedReason(file.patchOmitted)}{" "}
                        <a
                          href={pull?.url ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          到托管上看
                        </a>
                      </p>
                    ) : (
                      <ReviewDiff
                        file={file}
                        patch={patch?.patch ?? null}
                        highlightTicket={
                          file.path === selectedPath ? highlightTicket : null
                        }
                        hostUrl={pull?.url ?? "#"}
                        hunkIndex={file.path === selectedPath ? hunkIndex : -1}
                        canComment={canWrite}
                        onCommentLine={(input) =>
                          openLineCompose({ path: file.path, ...input })
                        }
                        onLoadContext={async ({ sha, from, to }) => {
                          const { data, error } = await api.GET(
                            "/review-blobs/{sha}",
                            {
                              params: {
                                path: { sha },
                                query: { from, to },
                              },
                            },
                          );
                          if (!data) throw new Error(describeError(error));
                          return data;
                        }}
                      />
                    )}
                  </article>
                );
              })
            : null}
        </div>
        <ReviewRail
          review={review as SpecReview}
          specState={review.spec.state}
          pull={pull}
          file={selected}
          highlightTicket={highlightTicket}
          comments={commentList}
          currentHead={pinnedHead}
          canWrite={canWrite}
          onEditComment={(item) =>
            setCompose({
              commentId: item.id,
              path: item.path,
              side: item.side,
              lineStart: item.lineStart,
              lineEnd: item.lineEnd,
              excerpt: null,
              body: item.body,
            })
          }
          onDeleteComment={(item) => removeComment.mutate(item.id)}
        />
      </div>
    </div>
  );
}

function staleDraftsOf(error: unknown): StaleReviewDraft[] | undefined {
  if (!error || typeof error !== "object" || !("stale" in error))
    return undefined;
  const stale = (error as { stale?: unknown }).stale;
  if (!Array.isArray(stale) || stale.length === 0) return undefined;
  return stale as StaleReviewDraft[];
}

function formatCommentId(id: number, comments: ReviewComment[]): string {
  return comments.find((item) => item.id === id)?.displayId ?? `C-${id}`;
}

function parsePatchCount(patch: string | null | undefined): number {
  if (!patch) return 0;
  return (patch.match(/^@@/gm) ?? []).length;
}

function FileList({
  files,
  selectedPath,
  onPick,
}: {
  files: ReviewFileView[];
  selectedPath: string | undefined;
  onPick: (path: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {files.map((file) => (
        <li key={`${file.id}-${file.path}`}>
          <button
            type="button"
            aria-label={file.path}
            aria-current={file.path === selectedPath ? "true" : undefined}
            className={cn(
              "flex w-full items-start gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent",
              file.path === selectedPath && "bg-accent",
            )}
            onClick={() => onPick(file.path)}
          >
            <span className="min-w-0 flex-1 break-all">{file.path}</span>
            <span className="shrink-0 text-muted-foreground">
              +{file.additions} −{file.deletions}
              {file.viewed ? " · 看过" : ""}
              {file.patchOmitted
                ? ` · ${omittedReason(file.patchOmitted)}`
                : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
