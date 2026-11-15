import { TICKET_STATES } from "@afk/shared";
import { useState } from "react";
import { RepoTag } from "../components/afk/badges.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { edgeKindLabel } from "../lib/labels.ts";
import { paths } from "../paths.ts";
import { StatusBadge } from "../StatusBadge.tsx";
import { ticketStateLabel } from "../status.ts";
import { peekTicketClick } from "../TicketDetail.tsx";
import { DependencyGraph } from "./dependency-graph.tsx";
import type { SpecView } from "./view.ts";

export function TicketsPage({
  tickets,
  edges,
  repos,
  onOpen,
}: {
  tickets: SpecView["tickets"];
  edges: SpecView["edges"];
  repos: NonNullable<SpecView["spec"]["repos"]>;
  onOpen: (id: number) => void;
}) {
  const [repo, setRepo] = useState("all");
  const [state, setState] = useState("all");
  const repoNames = [...new Set(tickets.map((t) => t.repo))];
  const repoUrl = new Map(repos.map((item) => [item.name, item.url]));
  const idByDisplay = new Map(
    tickets.map((ticket) => [ticket.displayId, ticket.id]),
  );
  const shown = tickets.filter(
    (t) =>
      (repo === "all" || t.repo === repo) &&
      (state === "all" || t.state === state),
  );
  const waitsFor = (displayId: string) =>
    edges.filter((e) => e.to === displayId);
  return (
    <>
      {tickets.length === 0 ? (
        <p className="note">还没有导入票。</p>
      ) : (
        <>
          <h3 className="mb-3 text-sm font-semibold">依赖图</h3>
          <DependencyGraph
            tickets={tickets}
            edges={edges}
            onOpen={onOpen}
            className="h-[480px]"
          />
        </>
      )}
      <div className="mt-6 mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-2 text-sm font-semibold">票</h3>
        <Select value={repo} onValueChange={setRepo}>
          <SelectTrigger
            className="h-7 w-auto gap-1.5 text-[12px]"
            aria-label="按仓库筛选"
          >
            <SelectValue placeholder="仓库" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部仓库</SelectItem>
            {repoNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={setState}>
          <SelectTrigger
            className="h-7 w-auto gap-1.5 text-[12px]"
            aria-label="按状态筛选"
          >
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {TICKET_STATES.map((value) => (
              <SelectItem key={value} value={value}>
                {ticketStateLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="space-y-2" data-testid="ticket-cards">
        {shown.map((ticket) => {
          const waits = waitsFor(ticket.displayId);
          return (
            <li
              key={ticket.id}
              className="rounded-md border bg-card px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="ticket" code={ticket.state} />
                <a
                  href={paths.ticket(ticket.id)}
                  className="font-mono text-sm hover:underline"
                  onClick={(event) => peekTicketClick(event, ticket.id, onOpen)}
                >
                  {ticket.displayId}
                </a>
                <span className="min-w-0 truncate text-sm">{ticket.title}</span>
                <RepoTag name={ticket.repo} url={repoUrl.get(ticket.repo)} />
                {ticket.appended ? (
                  <span className="badge appended">追加</span>
                ) : null}
                {ticket.blockedReason ? (
                  <StatusBadge kind="blocked" code={ticket.blockedReason} />
                ) : null}
              </div>
              {waits.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {waits.map((edge, index) => {
                    const targetId = idByDisplay.get(edge.from);
                    const kind = edgeKindLabel[edge.kind] ?? edge.kind;
                    return (
                      <span key={`${edge.from}-${edge.kind}`}>
                        {index > 0 ? " · " : null}
                        {kind}{" "}
                        {targetId ? (
                          <a
                            href={paths.ticket(targetId)}
                            className="font-mono text-primary hover:underline"
                            onClick={(event) =>
                              peekTicketClick(event, targetId, onOpen)
                            }
                          >
                            {edge.from}
                          </a>
                        ) : (
                          <span className="font-mono">{edge.from}</span>
                        )}
                      </span>
                    );
                  })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
