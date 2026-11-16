import {
  FAILURE_SOURCE_LABELS,
  type FailureSource,
  HOST_KIND_LABELS,
  type HostKind,
} from "@afk/shared";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { Pill } from "../components/afk/badges.tsx";
import { Hint } from "../components/afk/hint.tsx";
import { cn } from "../lib/utils.ts";
import { paths } from "../paths.ts";
import { RelativeTime } from "../RelativeTime.tsx";
import {
  ReviewEventText,
  ticketSummaryWithReview,
} from "../review-findings-menu.tsx";
import {
  groupTimeline,
  TIMELINE_LABELS,
  type TimelineEvent,
  type TimelineTicketRail,
  timelineLabel,
} from "../spec-timeline.ts";
import { list, type SpecView } from "./view.ts";

export function TimelinePage({
  events,
  tickets,
  pullRequests,
  hostKind,
  legacy,
}: {
  events: TimelineEvent[];
  tickets: { id: number; displayId: string; title: string }[];
  pullRequests: SpecView["pullRequests"];
  hostKind: HostKind;
  legacy: boolean;
}) {
  const days = useMemo(() => groupTimeline(events, tickets), [events, tickets]);
  const note = legacy ? (
    <p className="note" data-testid="timeline-legacy">
      时间线沿用旧拼法：此需求还没有事件
    </p>
  ) : null;
  if (events.length === 0)
    return (
      <>
        {note}
        <p className="note">还没有时间线事件</p>
      </>
    );
  const prHref = (text?: string) => {
    if (!text) return null;
    const prs = list(pullRequests);
    const match = prs.find(
      (pr) => text.includes(`#${pr.number}`) || text.includes(pr.repo),
    );
    return match?.url ?? prs[0]?.url ?? null;
  };
  const renderEvent = (event: TimelineEvent, key: string) => (
    <TimelineEventRow
      key={key}
      event={event}
      hostKind={hostKind}
      prHref={prHref}
      variant="rail"
    />
  );
  return (
    <>
      {note}
      <Hint className="mb-4">
        每张票默认一行摘要。行末有「曾卡住或重试」表示走过失败或重试，点开展开看门禁与
        Run。
      </Hint>
      <div className="timeline">
        {days.map(({ day, rails }) => (
          <section key={day} className="timeline-day">
            <h3 className="timeline-day-label">{day}</h3>
            <ol className="timeline-rail">
              {rails.map((rail) =>
                rail.type === "event" ? (
                  renderEvent(
                    rail.event,
                    `e-${rail.event.kind}-${rail.at}-${rail.event.runId ?? ""}`,
                  )
                ) : (
                  <TimelineTicketRailRow
                    key={`t-${rail.ticketId}`}
                    rail={rail}
                    hostKind={hostKind}
                    prHref={prHref}
                  />
                ),
              )}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}

function TimelineEventRow({
  event,
  hostKind,
  prHref,
  ticketId,
  variant = "rail",
}: {
  event: TimelineEvent;
  hostKind: HostKind;
  prHref: (text?: string) => string | null;
  ticketId?: number;
  variant?: "rail" | "nested";
}) {
  const label =
    event.kind in TIMELINE_LABELS
      ? timelineLabel(event.kind as keyof typeof TIMELINE_LABELS, hostKind)
      : event.kind;
  const host =
    event.kind === "pr-opened" ||
    event.kind === "pr-ready" ||
    event.kind === "merged"
      ? prHref(event.text)
      : null;
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="timeline-kind">{label}</span>
        {event.at ? <RelativeTime iso={event.at} /> : null}
        {event.failureSource ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="failure-source"
          >
            {FAILURE_SOURCE_LABELS[event.failureSource as FailureSource]}
          </span>
        ) : null}
      </div>
      {event.text && event.text !== label ? (
        <div className="mt-1 text-sm text-muted-foreground">
          {event.kind === "review" && ticketId != null ? (
            <ReviewEventText
              text={event.text}
              ticketId={ticketId}
              event={event}
            />
          ) : (
            event.text
          )}
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        {event.runId ? (
          <a
            href={paths.run(event.runId)}
            className="text-primary hover:underline"
          >
            R-{event.runId}
          </a>
        ) : null}
        {host ? (
          <a
            href={host}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {HOST_KIND_LABELS[hostKind]}
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
    </>
  );
  if (variant === "nested") {
    return (
      <div
        data-testid={
          event.kind === "ticket-blocked" ? "timeline-blocked-event" : undefined
        }
      >
        {body}
      </div>
    );
  }
  return (
    <li
      className="timeline-item"
      data-testid={
        event.kind === "ticket-blocked" ? "timeline-blocked-event" : undefined
      }
    >
      <span className="timeline-dot" aria-hidden="true" />
      {body}
    </li>
  );
}

function TimelineTicketRailRow({
  rail,
  hostKind,
  prHref,
}: {
  rail: TimelineTicketRail;
  hostKind: HostKind;
  prHref: (text?: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="timeline-item"
      data-testid="timeline-ticket-group"
      data-trouble={rail.hadTrouble ? "true" : undefined}
    >
      <span
        className={cn(
          "timeline-dot",
          rail.hadTrouble && "bg-state-blocked border-state-blocked",
        )}
        aria-hidden="true"
      />
      <div className="-ml-0.5 flex w-full items-start gap-2 rounded-md text-sm">
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-accent/40"
          aria-expanded={open}
          aria-label={open ? "收起票步骤" : "展开票步骤"}
          data-testid="timeline-ticket-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", !open && "-rotate-90")}
          />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block">
            <a
              href={paths.ticket(rail.ticketId)}
              className="font-mono text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {rail.displayId}
            </a>
            {rail.title ? (
              <span className="ml-2 font-medium text-foreground">
                {rail.title}
              </span>
            ) : null}
            <span className="ml-2">
              {ticketSummaryWithReview(
                rail.summary,
                rail.ticketId,
                rail.lastReview,
              )}
            </span>
            {rail.hadTrouble ? (
              <span
                className="ml-1.5 inline-flex align-middle"
                data-testid="timeline-ticket-trouble"
              >
                <Pill tone="blocked" dot={false}>
                  曾卡住或重试
                </Pill>
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {open ? "收起步骤" : "展开看门禁与 Run"}
            {rail.at ? (
              <>
                {" · "}
                <RelativeTime iso={rail.at} />
              </>
            ) : null}
          </span>
        </span>
      </div>
      {open ? (
        <ol className="ml-5 mt-2 space-y-0 border-l border-border pl-3">
          {rail.events.map((event) => (
            <li
              key={`${event.kind}-${event.at}-${event.runId ?? ""}`}
              className="border-border border-b border-dashed py-2 last:border-0"
            >
              <TimelineEventRow
                event={event}
                hostKind={hostKind}
                prHref={prHref}
                ticketId={rail.ticketId}
                variant="nested"
              />
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
