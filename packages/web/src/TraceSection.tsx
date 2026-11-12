import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { ShaChip } from "./components/afk/badges.tsx";
import { Hint } from "./components/afk/hint.tsx";
import { commitHtmlUrl } from "./host-links.ts";
import { cn } from "./lib/utils.ts";
import { paths } from "./paths.ts";
import { shortSha } from "./status.ts";

export type TraceLink = {
  kind: "ticket" | "pr";
  repo: string;
  sha: string;
  ticketId: number | null;
  ticketDisplayId: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
};

type PrGroup = {
  number: number;
  url: string | null;
  merge: TraceLink[];
};

type TicketGroup = {
  displayId: string;
  ticketId: number | null;
  rows: TraceLink[];
};

function uniqueBySha(rows: TraceLink[]): TraceLink[] {
  const seen = new Set<string>();
  const out: TraceLink[] = [];
  for (const row of rows) {
    if (seen.has(row.sha)) continue;
    seen.add(row.sha);
    out.push(row);
  }
  return out;
}

function groupTrace(links: TraceLink[]): {
  prGroups: PrGroup[];
  ticketGroups: TicketGroup[];
  wrapUp: TraceLink[];
  stats: { prCount: number; ticketCount: number; commitCount: number };
} {
  const prMap = new Map<number, PrGroup>();
  const ticketMap = new Map<string, TicketGroup>();
  const wrap: TraceLink[] = [];

  const touchPr = (link: TraceLink) => {
    if (link.pullRequestNumber == null) return;
    const existing = prMap.get(link.pullRequestNumber);
    if (existing) {
      if (!existing.url && link.pullRequestUrl)
        existing.url = link.pullRequestUrl;
      return existing;
    }
    const created: PrGroup = {
      number: link.pullRequestNumber,
      url: link.pullRequestUrl,
      merge: [],
    };
    prMap.set(link.pullRequestNumber, created);
    return created;
  };

  for (const link of links) {
    touchPr(link);
    if (link.ticketDisplayId) {
      const existing = ticketMap.get(link.ticketDisplayId);
      if (existing) existing.rows.push(link);
      else {
        ticketMap.set(link.ticketDisplayId, {
          displayId: link.ticketDisplayId,
          ticketId: link.ticketId,
          rows: [link],
        });
      }
    } else if (link.kind === "pr" && link.pullRequestNumber != null) {
      prMap.get(link.pullRequestNumber)?.merge.push(link);
    } else if (link.kind === "ticket") {
      wrap.push(link);
    }
  }

  return {
    prGroups: [...prMap.values()].sort((a, b) => a.number - b.number),
    ticketGroups: [...ticketMap.values()]
      .map((group) => ({ ...group, rows: uniqueBySha(group.rows) }))
      .sort((a, b) => (a.ticketId ?? 0) - (b.ticketId ?? 0)),
    wrapUp: uniqueBySha(wrap),
    stats: {
      prCount: prMap.size,
      ticketCount: ticketMap.size,
      commitCount: new Set(links.map((link) => link.sha)).size,
    },
  };
}

export function TraceSection({
  links,
  repos,
  ticketTitles,
}: {
  links: TraceLink[];
  repos: { name: string; url: string }[];
  ticketTitles: Map<string, string>;
}) {
  const { prGroups, ticketGroups, wrapUp, stats } = useMemo(
    () => groupTrace(links),
    [links],
  );

  const commitHref = (repoName: string, sha: string) => {
    const url = repos.find((repo) => repo.name === repoName)?.url;
    return url ? commitHtmlUrl(url, sha) : null;
  };

  return (
    <section className="mb-6" data-testid="spec-trace">
      <h3 className="mb-2 text-sm font-semibold">追溯</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        {stats.prCount} 个 PR · {stats.ticketCount} 张票 · {stats.commitCount}{" "}
        个提交
      </p>
      <Hint className="mb-4">
        进仓库的改动按当初那张票列在下面：看标题就知道改了什么。点票号打开票，点
        PR 号看这次合并。短 SHA
        只用来打开代码托管上的那次提交，不是给人读的。从本地文件反查用终端{" "}
        <code className="font-mono text-xs">plat context --files</code>
        ，页面不会扫你的工作区。
      </Hint>
      <div className="space-y-4">
        {prGroups.map((pr) => (
          <div
            key={`pr-${pr.number}`}
            className="rounded-lg border border-border-strong bg-surface p-3"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">这次合并</span>
              {pr.url ? (
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  #{pr.number}
                </a>
              ) : (
                <span className="font-mono">#{pr.number}</span>
              )}
            </div>
            {pr.merge.length > 0 ? (
              <ul className="mt-2 flex flex-wrap items-center gap-2">
                {uniqueBySha(pr.merge).map((row) => (
                  <li key={row.sha} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      合并提交
                    </span>
                    <ShaChip
                      sha={row.sha}
                      href={commitHref(row.repo, row.sha)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {ticketGroups.map((group) => (
          <TicketTraceGroup
            key={group.displayId}
            displayId={group.displayId}
            title={ticketTitles.get(group.displayId)}
            ticketId={group.ticketId}
            rows={group.rows}
            commitHref={commitHref}
          />
        ))}
        {wrapUp.length > 0 ? (
          <div className="rounded-lg border border-border-strong bg-surface p-3">
            <p className="mb-2 text-sm font-medium">收尾修复</p>
            <ul className="flex flex-wrap gap-2">
              {wrapUp.map((row) => (
                <li key={row.sha}>
                  <ShaChip sha={row.sha} href={commitHref(row.repo, row.sha)} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TicketTraceGroup({
  displayId,
  title,
  ticketId,
  rows,
  commitHref,
}: {
  displayId: string;
  title: string | undefined;
  ticketId: number | null;
  rows: TraceLink[];
  commitHref: (repoName: string, sha: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const first = rows[0];
  const firstHref = first ? commitHref(first.repo, first.sha) : null;
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent/50"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block">
            {ticketId ? (
              <a
                href={paths.ticket(ticketId)}
                className="font-mono text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {displayId}
              </a>
            ) : (
              <span className="font-mono">{displayId}</span>
            )}
            {title ? (
              <span className="ml-2 font-medium text-foreground">{title}</span>
            ) : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {rows.length} 个提交
            {!open && rows.length === 1 && first ? (
              <>
                {" · 打开提交 "}
                {firstHref ? (
                  <a
                    href={firstHref}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {shortSha(first.sha)}
                  </a>
                ) : (
                  <span className="font-mono">{shortSha(first.sha)}</span>
                )}
              </>
            ) : open ? (
              "，点短 SHA 打开代码托管"
            ) : (
              "，展开看提交"
            )}
          </span>
        </span>
      </button>
      {open ? (
        <ul className="flex flex-wrap gap-2 border-t px-3 py-2">
          {rows.map((row) => (
            <li key={row.sha}>
              <ShaChip sha={row.sha} href={commitHref(row.repo, row.sha)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
