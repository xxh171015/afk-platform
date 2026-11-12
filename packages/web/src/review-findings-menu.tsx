import { useQuery } from "@tanstack/react-query";
import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { cn } from "./lib/utils.ts";
import { paths } from "./paths.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { parseReviewFindingMeta, type TimelineEvent } from "./spec-timeline.ts";

type Finding = {
  id: number;
  runId: number;
  kind: string;
  body: string;
  resolution: string;
  axis: string | null;
};

function stopBubble(event: MouseEvent) {
  event.stopPropagation();
}

export function ReviewFindingsMenu({
  ticketId,
  runId,
  count,
  className,
}: {
  ticketId: number;
  runId: number;
  count: number;
  className?: string;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ticket = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: Event) => {
      const node = rootRef.current;
      if (
        node &&
        event.target instanceof Node &&
        !node.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (count <= 0) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        review 0 条意见
      </span>
    );
  }

  const findings =
    ticket.data?.findings.filter((row) => row.runId === runId) ?? [];

  return (
    <span ref={rootRef} className="relative inline">
      <button
        type="button"
        className={cn(
          "rounded-sm text-primary underline-offset-2 hover:underline",
          className,
        )}
        data-testid="review-findings-trigger"
        aria-expanded={open}
        onClick={(event) => {
          stopBubble(event);
          setOpen((value) => !value);
        }}
      >
        review {count} 条意见
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-md"
          data-testid="review-findings-panel"
        >
          <div className="border-b border-border px-3 py-2 text-xs font-medium">
            R-{runId} · review · {count} 条意见
          </div>
          <div className="space-y-3 p-3">
            {ticket.isPending ? (
              <p className="text-xs text-muted-foreground">加载意见…</p>
            ) : ticket.isError ? (
              <p className="text-xs text-state-blocked" role="alert">
                无法加载意见
              </p>
            ) : findings.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                这次 review 没有记录
              </p>
            ) : (
              <ul className="space-y-2">
                {findings.map((finding: Finding) => (
                  <li key={finding.id} className="text-[13px] leading-snug">
                    <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge kind="pr" code={finding.resolution} />
                      {finding.axis ? (
                        <span
                          className={`font-mono text-[11px] axis-${finding.axis}`}
                        >
                          {finding.axis}
                        </span>
                      ) : null}
                      <span className="text-muted-foreground">
                        {finding.kind}
                      </span>
                    </div>
                    <p className="text-foreground">{finding.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <a
              href={paths.ticket(ticketId)}
              className="block text-xs text-primary hover:underline"
              onClick={stopBubble}
            >
              在票里看全部
            </a>
          </div>
        </div>
      ) : null}
    </span>
  );
}

export function ReviewEventText({
  text,
  ticketId,
  event,
}: {
  text: string;
  ticketId: number;
  event: TimelineEvent;
}) {
  const meta = parseReviewFindingMeta(event);
  if (!meta) return text;
  const suffix = `review ${meta.count} 条意见`;
  const idx = text.indexOf(suffix);
  if (idx === -1) {
    return (
      <ReviewFindingsMenu
        ticketId={ticketId}
        runId={meta.runId}
        count={meta.count}
      />
    );
  }
  return (
    <>
      {text.slice(0, idx)}
      <ReviewFindingsMenu
        ticketId={ticketId}
        runId={meta.runId}
        count={meta.count}
        className="text-muted-foreground hover:text-primary"
      />
    </>
  );
}

export function ticketSummaryWithReview(
  summary: string,
  ticketId: number,
  lastReview: { runId: number; count: number } | null,
) {
  if (!lastReview || !summary.includes("条意见")) {
    return <span className="text-muted-foreground">· {summary}</span>;
  }
  const suffix = `review ${lastReview.count} 条意见`;
  const head = summary.includes(suffix)
    ? summary.replace(new RegExp(` · ${suffix}$`), "").replace(suffix, "")
    : summary;
  const prefix = head.length > 0 ? `· ${head} · ` : "· ";
  return (
    <span className="text-muted-foreground">
      {prefix}
      <ReviewFindingsMenu
        ticketId={ticketId}
        runId={lastReview.runId}
        count={lastReview.count}
        className="text-muted-foreground hover:text-primary"
      />
    </span>
  );
}
