import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRight, Clock3, FileText, Inbox, Loader2 } from "lucide-react";
import { searchQuery } from "@/api/queries";
import { StateBadge } from "@/components/afk/badges";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useDebouncedSearch } from "@/hooks/use-search";
import { bodyExcerpt, highlightParts, readRecentVisits, recordVisit, SEARCH_MAX_LENGTH, type RecentVisit } from "@/lib/search";

function Highlight({ text, query }: { text: string; query: string }) {
  return <>{highlightParts(text, query).map((part, i) => part.match
    ? <mark key={i} className="rounded-sm bg-primary/15 text-primary">{part.text}</mark>
    : <span key={i}>{part.text}</span>)}</>;
}

export function CommandSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState("");
  const [recent] = useState(readRecentVisits);
  const debounced = useDebouncedSearch(q);
  const navigate = useNavigate();
  const { data, error, isFetching, refetch } = useQuery({ ...searchQuery(debounced), enabled: open && debounced.length > 0 });
  const pending = q.trim() !== debounced || isFetching;
  const hasInput = q.trim().length > 0;
  const results = !pending && hasInput && !error ? data : undefined;

  function visit(target: RecentVisit) {
    recordVisit(target);
    onOpenChange(false);
    if (target.kind === "run") void navigate({ to: "/runs/$id", params: { id: target.id } });
    else if (target.kind === "spec") void navigate({ to: "/specs/$id", params: { id: target.id }, search: {} });
    else if (target.kind === "ticket") void navigate({ to: "/tickets/$id", params: { id: target.id }, search: {} });
  }

  const jump = results?.jump;
  const specs = results?.specs.filter(s => jump?.kind !== "spec" || s.id !== jump.id) ?? [];
  const tickets = results?.tickets.filter(t => jump?.kind !== "ticket" || t.id !== jump.id) ?? [];

  return <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
    <CommandInput aria-label="搜索需求、票和运行" placeholder="搜索编号、标题或正文…" maxLength={SEARCH_MAX_LENGTH} value={q} onValueChange={v => setQ(v.slice(0, SEARCH_MAX_LENGTH))} />
    <CommandList className="max-h-[min(480px,65dvh)]">
      {!hasInput ? <>
        <CommandGroup heading="最近访问">
          {recent.length ? recent.map(v => <CommandItem key={`${v.kind}-${v.id}`} value={`recent-${v.kind}-${v.id}`} onSelect={() => visit(v)}>
            <Clock3 className="text-muted-foreground" /><span className="w-14 shrink-0 font-mono text-xs">{v.displayId}</span><span className="min-w-0 flex-1 truncate">{v.title}</span>
          </CommandItem>) : <p className="px-2 py-4 text-xs text-muted-foreground">暂无最近访问</p>}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="快捷入口">
          <CommandItem value="quick-waiting" onSelect={() => { onOpenChange(false); void navigate({ to: "/waiting", search: {} }); }}><Inbox className="text-muted-foreground" />待处理</CommandItem>
          <CommandItem value="quick-specs" onSelect={() => { onOpenChange(false); void navigate({ to: "/specs" }); }}><FileText className="text-muted-foreground" />需求列表</CommandItem>
        </CommandGroup>
      </> : pending ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在搜索…</div>
        : error ? <div role="alert" className="space-y-3 px-4 py-8 text-center"><p className="text-sm text-destructive">搜索失败：{error instanceof Error ? error.message : "暂时无法读取搜索结果"}</p><Button variant="outline" size="sm" onClick={() => void refetch()}>重新搜索</Button></div>
        : <>
          {jump && <CommandGroup heading="编号直达"><CommandItem value={`jump-${jump.id}`} onSelect={() => visit(jump)}>
            <span className="w-14 shrink-0 font-mono text-xs"><Highlight text={jump.displayId} query={debounced} /></span>
            <div className="min-w-0 flex-1"><p className="truncate"><Highlight text={jump.title} query={debounced} /></p>{jump.kind === "run" && <p className="mt-1 text-[10px] text-muted-foreground"><span className="font-mono">{jump.stage} · {jump.state}</span> · 属于 <span className="font-mono">{jump.specDisplayId}</span></p>}{jump.kind === "ticket" && <p className="mt-1 text-[10px] text-muted-foreground">属于 <span className="font-mono">{jump.specDisplayId}</span></p>}</div>
            {jump.kind === "spec" && <StateBadge kind="spec" state={jump.state} />}{jump.kind === "ticket" && <StateBadge kind="ticket" state={jump.state} />}
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-primary">跳转 <ArrowUpRight className="size-3" /></span>
          </CommandItem></CommandGroup>}
          {specs.length > 0 && <CommandGroup heading="需求">{specs.map(s => <CommandItem key={s.id} value={`spec-${s.id}`} onSelect={() => visit({ kind: "spec", ...s })}>
            <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground"><Highlight text={s.displayId} query={debounced} /></span>
            <div className="min-w-0 flex-1"><p className="truncate"><Highlight text={s.title} query={debounced} /></p><p className="mt-1 text-[10px] text-muted-foreground">命中了 <span className="font-mono">{s.matched.join(" / ")}</span></p>{s.matched.includes("body") && s.bodySnippet && <p className="mt-1 truncate text-xs text-muted-foreground"><Highlight text={bodyExcerpt(s.bodySnippet, debounced)} query={debounced} /></p>}</div>
            <StateBadge kind="spec" state={s.state} />
          </CommandItem>)}</CommandGroup>}
          {tickets.length > 0 && <CommandGroup heading="票">{tickets.map(t => <CommandItem key={t.id} value={`ticket-${t.id}`} onSelect={() => visit({ kind: "ticket", ...t })}>
            <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground"><Highlight text={t.displayId} query={debounced} /></span>
            <div className="min-w-0 flex-1"><p className="truncate"><Highlight text={t.title} query={debounced} /></p><p className="mt-1 text-[10px] text-muted-foreground">属于 <span className="font-mono">{t.specDisplayId}</span> · 命中了 <span className="font-mono">{t.matched.join(" / ")}</span></p>{t.matched.includes("body") && <p className="mt-1 truncate text-xs text-muted-foreground"><Highlight text={bodyExcerpt(t.body, debounced)} query={debounced} /></p>}</div>
            <StateBadge kind="ticket" state={t.state} />
          </CommandItem>)}</CommandGroup>}
          {!jump && !specs.length && !tickets.length && <p role="status" className="break-words px-4 py-10 text-center text-sm text-muted-foreground">没有找到 &quot;{debounced}&quot;</p>}
        </>}
    </CommandList>
    {q.length === SEARCH_MAX_LENGTH && <p className="border-t px-3 py-2 text-[10px] text-muted-foreground">已达到 200 个字符上限</p>}
  </CommandDialog>;
}