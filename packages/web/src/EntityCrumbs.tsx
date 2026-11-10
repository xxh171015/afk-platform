import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ChevronDown, ExternalLink, MoreHorizontal } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { toast } from "sonner";
import { describeError, useApi } from "./api.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { useResourcePoll } from "./EventsProvider.tsx";
import { ownerFromRepos, ownerFromUrl, repoHtmlUrl } from "./host-links.ts";
import { LIST_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";

async function copyText(label: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已复制 ${label}`);
  } catch {
    toast.error("复制失败");
  }
}

function CrumbSep() {
  return <span className="text-subtle-foreground">›</span>;
}

function CrumbLink({
  href,
  children,
  external,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="text-muted-foreground hover:text-foreground"
    >
      {children}
    </a>
  );
}

function SiblingMenu({
  label,
  items,
  currentId,
}: {
  label: ReactNode;
  items: { id: number; href: string; text: string }[];
  currentId: number;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-[min(28rem,50vw)] items-center gap-1 truncate text-foreground hover:text-primary"
          aria-label="切换兄弟项"
          data-testid="crumb-siblings"
          data-count={items.length}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <a href={item.href} className="flex w-full items-center gap-2">
              <DropdownMenuCheck checked={item.id === currentId} />
              <span className="truncate">{item.text}</span>
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type OverflowItem =
  | { kind: "copy"; label: string; value: string }
  | { kind: "link"; label: string; href: string; external?: boolean };

function OverflowMenu({ items }: { items: OverflowItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="更多操作"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item, index) => {
          const previous = items[index - 1];
          const split =
            previous &&
            ((previous.kind === "copy" && item.kind === "link") ||
              (previous.kind === "link" &&
                item.kind === "link" &&
                Boolean(previous.external) !== Boolean(item.external)));
          return (
            <Fragment key={`${item.kind}-${item.label}`}>
              {split ? <DropdownMenuSeparator /> : null}
              {item.kind === "copy" ? (
                <DropdownMenuItem
                  onSelect={() => void copyText(item.label, item.value)}
                >
                  {item.label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem asChild>
                  <a
                    href={item.href}
                    {...(item.external
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                    className="flex w-full items-center gap-2"
                  >
                    {item.label}
                    {item.external ? <ExternalLink className="size-3" /> : null}
                  </a>
                </DropdownMenuItem>
              )}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function parsePath(path: string): {
  specId?: number;
  ticketId?: number;
  runId?: number;
} {
  const spec = /^\/specs\/(\d+)/.exec(path);
  if (spec) return { specId: Number(spec[1]) };
  const ticket = /^\/tickets\/(\d+)/.exec(path);
  if (ticket) return { ticketId: Number(ticket[1]) };
  const run = /^\/runs\/(\d+)/.exec(path);
  if (run) return { runId: Number(run[1]) };
  return {};
}

function staticCrumbs(
  path: string,
): { label: ReactNode; to?: string }[] | null {
  if (path === "/") return [{ label: "工作台" }];
  if (path === "/waiting") return [{ label: "待处理" }];
  if (path === "/metrics") return [{ label: "度量" }];
  if (path === "/specs") return [{ label: "需求" }];
  return null;
}

export function EntityCrumbs() {
  const api = useApi();
  const poll = useResourcePoll(LIST_POLL_MS);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const ids = parsePath(path);
  const run = useQuery({
    queryKey: ["run", ids.runId],
    enabled: ids.runId !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/runs/{id}", {
        params: { path: { id: ids.runId as number } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const ticketId = ids.ticketId ?? run.data?.ticketId ?? undefined;
  const ticket = useQuery({
    queryKey: ["ticket", ticketId],
    enabled: ticketId !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/tickets/{id}", {
        params: { path: { id: ticketId as number } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
  const specId =
    ids.specId ?? ticket.data?.ticket.specId ?? run.data?.specId ?? undefined;
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
  const specs = useQuery({
    queryKey: ["search", "S-"],
    enabled: specId !== undefined,
    queryFn: async () => {
      const { data, error } = await api.GET("/search", {
        params: { query: { q: "S-" } },
      });
      if (!data) throw new Error(describeError(error));
      return data.specs;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

  const plain = staticCrumbs(path);
  const specView = spec.data;
  const ticketView = ticket.data;
  const runView = run.data;
  const list = specs.data ?? [];
  const owner =
    ownerFromRepos(specView?.spec.repos ?? []) ??
    ownerFromUrl(ticketView?.ticket.repoUrl) ??
    ownerFromUrl(runView?.repoUrl);
  const github =
    specView?.pullRequests?.find((pr) => pr.url)?.url ??
    (specView?.spec.repos?.[0]
      ? repoHtmlUrl(specView.spec.repos[0].url)
      : null) ??
    (ticketView?.ticket.repoUrl
      ? repoHtmlUrl(ticketView.ticket.repoUrl)
      : null) ??
    (runView?.repoUrl ? repoHtmlUrl(runView.repoUrl) : null);

  const overflow: OverflowItem[] = [];
  const displayId =
    runView?.displayId ??
    ticketView?.ticket.displayId ??
    specView?.spec.displayId;
  if (displayId)
    overflow.push({ kind: "copy", label: "复制编号", value: displayId });
  overflow.push({
    kind: "copy",
    label: "复制链接",
    value: `${window.location.origin}${path}`,
  });
  if (github)
    overflow.push({
      kind: "link",
      label: "在 GitHub 打开",
      href: github,
      external: true,
    });
  if (specId !== undefined) {
    overflow.push(
      { kind: "link", label: "概览", href: paths.spec(specId) },
      { kind: "link", label: "需求说明", href: paths.specDescription(specId) },
      { kind: "link", label: "票与依赖", href: paths.specTickets(specId) },
      { kind: "link", label: "交付", href: paths.specDelivery(specId) },
      { kind: "link", label: "时间线", href: paths.specTimeline(specId) },
    );
  }
  if (
    ticketView &&
    (ticketView.ticket.state === "pending" ||
      ticketView.ticket.state === "blocked")
  ) {
    overflow.push({
      kind: "link",
      label: "改正文",
      href: `${paths.ticket(ticketView.ticket.id)}#ticket-file-${ticketView.ticket.id}`,
    });
  }

  const specSiblings = list.map((item) => ({
    id: item.id,
    href: paths.spec(item.id),
    text: `${item.displayId} ${item.title}`,
  }));
  const ticketSiblings = (specView?.tickets ?? []).map((item) => ({
    id: item.id,
    href: paths.ticket(item.id),
    text: `${item.displayId} ${item.title}`,
  }));

  return (
    <nav
      aria-label="面包屑"
      data-testid="entity-crumbs"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
    >
      {plain
        ? plain.map((crumb) => (
            <span
              key={`${String(crumb.label)}-${crumb.to ?? "current"}`}
              className="flex items-center gap-1.5"
            >
              {crumb.to ? (
                <CrumbLink href={crumb.to}>{crumb.label}</CrumbLink>
              ) : (
                <span className="text-foreground">{crumb.label}</span>
              )}
            </span>
          ))
        : null}
      {!plain && owner ? (
        <>
          <CrumbLink href={owner.href ?? "#"} external={Boolean(owner.href)}>
            {owner.owner}
          </CrumbLink>
          <CrumbSep />
        </>
      ) : null}
      {!plain ? (
        <>
          <CrumbLink href={paths.specs}>需求</CrumbLink>
          {specId !== undefined ? (
            <>
              <CrumbSep />
              {ids.runId ? (
                <CrumbLink href={paths.spec(specId)}>
                  <span className="font-mono">
                    {specView?.spec.displayId ?? `S-${specId}`}
                  </span>
                </CrumbLink>
              ) : (
                <SiblingMenu
                  currentId={specId}
                  items={specSiblings}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono">
                        {specView?.spec.displayId ?? `S-${specId}`}
                      </span>
                      {ids.specId && specView?.spec.title ? (
                        <span className="truncate">{specView.spec.title}</span>
                      ) : null}
                    </span>
                  }
                />
              )}
            </>
          ) : null}
          {ticketId !== undefined ? (
            <>
              <CrumbSep />
              {ids.runId ? (
                <CrumbLink href={paths.ticket(ticketId)}>
                  <span className="font-mono">
                    {ticketView?.ticket.displayId ?? `T-${ticketId}`}
                  </span>
                </CrumbLink>
              ) : (
                <SiblingMenu
                  currentId={ticketId}
                  items={ticketSiblings}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono">
                        {ticketView?.ticket.displayId ?? `T-${ticketId}`}
                      </span>
                      {ticketView?.ticket.title ? (
                        <span className="truncate">
                          {ticketView.ticket.title}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              )}
            </>
          ) : null}
          {ids.runId !== undefined ? (
            <>
              <CrumbSep />
              <span className="font-mono text-foreground">
                {runView?.displayId ?? `R-${ids.runId}`}
              </span>
            </>
          ) : null}
          <OverflowMenu items={overflow} />
        </>
      ) : null}
    </nav>
  );
}
