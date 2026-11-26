import {
  autoMergeLine,
  findingResolutionPhrase,
  reviewAxisLabel,
} from "@afk/shared";
import { useState } from "react";
import { prCiLabel } from "./lib/labels.ts";
import { cn } from "./lib/utils.ts";
import { paths } from "./paths.ts";
import type { ReviewFileView } from "./review-model.ts";
import { ticketsOf } from "./review-model.ts";

type SpecReview = {
  userStories: { number: number; text: string }[];
  tickets: {
    id: number;
    displayId: string;
    title: string;
    stories: number[];
    criteria: {
      text: string;
      tests: string[];
      status: "verified" | "unverified";
      reason: string | null;
    }[];
  }[];
  findings: {
    ticket: string | null;
    run: string;
    stage: string;
    kind: string;
    body: string;
    resolution: string;
    axis: string | null;
  }[];
  acceptancePack: {
    mergeOrder?: { ordered: string[]; unordered: string[] };
    orderBroken?: { repo: string; skipped: string[] }[];
    needsDecision?: {
      kind: string;
      id: string;
      source: string;
      text: string;
      ref?: string;
    }[];
    repos?: {
      repo: string;
      scopeCreep?: { ticket: string | null; run: string; body: string }[];
      reviewUncertainties?: {
        ticket: string | null;
        run: string;
        stage: string;
        body: string;
        axis: string | null;
      }[];
    }[];
  } | null;
  autoMerge: Parameters<typeof autoMergeLine>[0];
};

export function ReviewRail({
  review,
  specState,
  pull,
  file,
  highlightTicket,
}: {
  review: SpecReview;
  specState: string;
  pull: {
    ci: string;
    conflictsWithDefault: boolean;
  } | null;
  file: ReviewFileView | undefined;
  highlightTicket: string | null;
}) {
  const currentTickets = highlightTicket
    ? [highlightTicket]
    : file
      ? ticketsOf(file)
      : [];
  const tickets = review.tickets.filter(
    (ticket) =>
      currentTickets.length === 0 || currentTickets.includes(ticket.displayId),
  );
  const unverified = review.tickets.flatMap((ticket) =>
    ticket.criteria
      .filter((item) => item.status === "unverified")
      .map((item) => ({ ticket: ticket.displayId, ...item })),
  );
  const findings = review.findings.filter(
    (item) =>
      currentTickets.length === 0 ||
      (item.ticket !== null && currentTickets.includes(item.ticket)),
  );
  const pack = review.acceptancePack;
  const mergeLine = autoMergeLine(review.autoMerge, specState);
  const ordered = pack?.mergeOrder?.ordered ?? [];
  const unordered = pack?.mergeOrder?.unordered ?? [];
  const scope = (pack?.repos ?? []).flatMap((repo) => repo.scopeCreep ?? []);
  const uncertainties = (pack?.repos ?? []).flatMap(
    (repo) => repo.reviewUncertainties ?? [],
  );
  const [tab, setTab] = useState<"checklist" | "spec" | "findings">(
    "checklist",
  );

  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label="审查右栏"
        className="mb-2 flex flex-wrap gap-1"
      >
        {(
          [
            ["checklist", "合并前清单"],
            ["spec", "需求与票"],
            ["findings", "Finding"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              "rounded-md px-2 py-1 text-xs",
              tab === id ? "bg-accent font-medium" : "text-muted-foreground",
            )}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "checklist" ? (
        <div role="tabpanel" className="space-y-3 text-sm">
          {(pack?.needsDecision ?? []).length > 0 ? (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">
                待人定
              </h3>
              <ul>
                {(pack?.needsDecision ?? []).map((item) => (
                  <li key={item.id}>
                    [{item.kind}] {item.source}: {item.text}
                    {item.ref ? ` (${item.ref})` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {unverified.length > 0 ? (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">
                未验证验收标准
              </h3>
              <ul>
                {unverified.map((item) => (
                  <li key={`${item.ticket}-${item.text}`}>
                    {item.ticket} {item.text}
                    {item.reason ? ` — ${item.reason}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {pull ? (
            <p>
              {prCiLabel[pull.ci] ?? pull.ci}
              {pull.conflictsWithDefault
                ? "，与默认分支冲突"
                : "，与默认分支不冲突"}
            </p>
          ) : null}
          <p>
            {ordered.length > 0
              ? `合并顺序：${ordered.join(" → ")}`
              : "没有合并顺序（没有契约关系）"}
            {unordered.length > 0 ? ` 没有顺序：${unordered.join("、")}` : ""}
          </p>
          {mergeLine ? <p>{mergeLine}</p> : null}
          {(pack?.orderBroken ?? []).map((item) => (
            <p key={item.repo} className="error">
              合并顺序被打破：{item.repo} 合在了 {item.skipped.join("、")}{" "}
              前面。
            </p>
          ))}
          <p className="note">人审意见还不能写</p>
        </div>
      ) : null}
      {tab === "spec" ? (
        <div role="tabpanel" className="space-y-3 text-sm">
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">
              User Story
            </h3>
            <ul>
              {(review.userStories ?? []).map((story) => (
                <li key={story.number}>
                  {story.number}. {story.text}
                </li>
              ))}
            </ul>
          </section>
          {tickets.map((ticket) => (
            <section key={ticket.id}>
              <p>
                <a href={paths.ticket(ticket.id)}>{ticket.displayId}</a>{" "}
                {ticket.title}
              </p>
              {ticket.stories.length > 0 ? (
                <p className="note">User Story {ticket.stories.join("、")}</p>
              ) : null}
              <ul>
                {ticket.criteria.map((item) => (
                  <li key={item.text}>
                    {item.status === "verified" ? "已验证" : "未验证"}{" "}
                    {item.text}
                    {item.reason ? ` — ${item.reason}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {tab === "findings" ? (
        <div role="tabpanel" className="space-y-3 text-sm">
          <ul>
            {findings.map((item) => (
              <li key={`${item.run}-${item.body}`}>
                {item.ticket ?? "spec"} {item.stage} {item.kind}
                {item.axis
                  ? ` · ${reviewAxisLabel(item.axis) ?? item.axis}`
                  : ""}
                ：{item.body}（{findingResolutionPhrase(item.resolution)}）
              </li>
            ))}
          </ul>
          {scope.length > 0 ? (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">
                范围外改动
              </h3>
              <ul>
                {scope.map((item) => (
                  <li key={`${item.run}-${item.body}`}>
                    {item.ticket ?? "spec"} {item.run}: {item.body}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {uncertainties.length > 0 ? (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">
                审查疑点
              </h3>
              <ul>
                {uncertainties.map((item) => (
                  <li key={`${item.run}-${item.body}`}>
                    {item.ticket ?? "spec"} {item.body}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
