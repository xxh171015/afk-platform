import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Anser from "anser";
import { ArrowDown, ArrowUp, Copy, Download, Search, WrapText, Maximize, Minimize } from "lucide-react";
import { toast } from "sonner";
import { runLogsQuery } from "@/api/queries";
import type { JsonValue, Run } from "@/api/types";
import { appendLogChunk, emptyLogBuffer } from "@/lib/ticket-runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { classifyLogLine, type LogAction } from "@/lib/view-map";
import { Mono } from "./badges";
import { cn } from "@/lib/utils";
import { ErrorState, Skeleton, StaleNotice } from "./states";

const actions: LogAction[] = ["读取", "修改", "运行命令", "agent 说明"];
const actionClass: Record<LogAction, string> = { "读取": "text-terminal-cyan border-terminal-cyan/30", "修改": "text-terminal-magenta border-terminal-magenta/30", "运行命令": "text-terminal-warning border-terminal-warning/30", "agent 说明": "text-terminal-success border-terminal-success/30" };
const ansiClasses: Record<string, string> = { red: "text-terminal-danger", green: "text-terminal-success", yellow: "text-terminal-warning", blue: "text-terminal-blue", cyan: "text-terminal-cyan", magenta: "text-terminal-magenta" };
function AnsiLine({ text, search }: { text: string; search: string }) {
  const pieces = Anser.ansiToJson(text, { use_classes: true, remove_empty: true });
  return <>{pieces.map((p, i) => {
    const matchColor = Object.keys(ansiClasses).find(c => p.fg?.includes(c));
    const parts = search ? p.content.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")) : [p.content];
    return <span key={i} className={matchColor ? ansiClasses[matchColor] : undefined}>{parts.map((part, j) => search && part.toLowerCase() === search.toLowerCase() ? <mark key={j} className="bg-state-paused/30 text-terminal-foreground">{part}</mark> : part)}</span>;
  })}</>;
}
export function RunLogViewer({ run }: { run: Run }) {
  const [buffer, setBuffer] = useState(emptyLogBuffer);
  const [search, setSearch] = useState(""); const [matchIndex, setMatchIndex] = useState(0);
  const [wrap, setWrap] = useState(false); const [pretty, setPretty] = useState(true); const [follow, setFollow] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [enabledActions, setEnabledActions] = useState<LogAction[]>(actions);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { setBuffer(emptyLogBuffer()); setFollow(true); }, [run.id]);
  useEffect(() => { if (!fullScreen) return; const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; const close = (e: KeyboardEvent) => { if (e.key === "Escape") setFullScreen(false); }; window.addEventListener("keydown", close); return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", close); }; }, [fullScreen]);
  const query = useQuery({ ...runLogsQuery(run.id, buffer.offset, run.attempt), enabled: !buffer.finished, refetchInterval: buffer.finished ? false : 3000, staleTime: 0 });
  useEffect(() => { setBuffer(previous => previous.attempt !== null && previous.attempt !== run.attempt ? { ...emptyLogBuffer(), attempt: run.attempt, restarted: true } : previous); }, [run.attempt]);
  useEffect(() => { if (query.data && query.data.attempt >= run.attempt) setBuffer(previous => appendLogChunk(previous, query.data)); }, [query.data, query.dataUpdatedAt, run.attempt]);
  useEffect(() => { if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [buffer.text, follow, pretty, fullScreen, enabledActions]);
  const lines = useMemo(() => buffer.text.replace(/\n$/, "").split("\n"), [buffer.text]);
  const visibleLines = useMemo(() => lines.flatMap((line, i) => { const mapped = classifyLogLine(line); return !pretty || enabledActions.includes(mapped.action) ? [{ line, i, ...mapped }] : []; }), [lines, pretty, enabledActions]);
  const matches = useMemo(() => search ? visibleLines.filter(l => l.line.toLowerCase().includes(search.toLowerCase()) || l.summary.toLowerCase().includes(search.toLowerCase())).map(l => l.i) : [], [visibleLines, search]);
  const selectMatch = (direction: number) => {
    if (!matches.length) return;
    const index = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index); setFollow(false);
    viewport.current?.querySelector(`[data-line="${matches[index]}"]`)?.scrollIntoView({ block: "nearest" });
  };
  return <section aria-label="日志查看器" className={cn("flex flex-col overflow-hidden border bg-background", fullScreen ? "fixed inset-0 z-50" : "rounded-md")}><div className="flex flex-wrap items-center gap-2 border-b bg-surface px-3 py-2"><h2 className="mr-auto text-sm font-semibold">日志 <Mono>{run.displayId}</Mono></h2><div className="flex rounded-sm border"><Button size="sm" variant={!pretty ? "secondary" : "ghost"} className="h-6 text-xs" onClick={() => setPretty(false)}>原始</Button><Button size="sm" variant={pretty ? "secondary" : "ghost"} className="h-6 text-xs" onClick={() => setPretty(true)}>动作</Button></div><Button size="icon" variant="ghost" className="size-7" title={fullScreen ? "退出全屏" : "全屏日志"} aria-label={fullScreen ? "退出全屏" : "全屏日志"} onClick={() => setFullScreen(v => !v)}>{fullScreen ? <Minimize /> : <Maximize />}</Button><Button size="icon" variant={wrap ? "secondary" : "ghost"} className="size-7" title="自动换行" aria-label="自动换行" aria-pressed={wrap} onClick={() => setWrap(v => !v)}><WrapText /></Button><Button size="icon" variant="ghost" className="size-7" title="复制日志" aria-label="复制日志" onClick={async () => { try { await navigator.clipboard.writeText(buffer.text); toast.success("日志已复制"); } catch { toast.error("复制失败"); } }}><Copy /></Button><Button size="icon" variant="ghost" className="size-7" title="下载日志" aria-label="下载日志" onClick={() => { const url = URL.createObjectURL(new Blob([buffer.text], { type: "text/plain;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = `${run.displayId}.log`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download /></Button></div>
    <div className="flex items-center gap-1 border-b bg-surface px-3 py-2"><Search className="size-3.5 text-muted-foreground" /><Input aria-label="搜索日志" value={search} onChange={e => { setSearch(e.target.value); setMatchIndex(0); }} className="h-7 min-w-0 flex-1 border-0 bg-transparent text-xs shadow-none" placeholder="搜索日志…" /><Mono className="text-[10px] text-muted-foreground">{matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0"}</Mono><Button size="icon" variant="ghost" className="size-6" title="上一个匹配" aria-label="上一个匹配" disabled={!matches.length} onClick={() => selectMatch(-1)}><ArrowUp /></Button><Button size="icon" variant="ghost" className="size-6" title="下一个匹配" aria-label="下一个匹配" disabled={!matches.length} onClick={() => selectMatch(1)}><ArrowDown /></Button></div>
    <div className="flex flex-wrap gap-2 border-b bg-surface px-3 py-2" aria-label="日志动作筛选">{actions.map(action => <Button key={action} size="sm" variant={enabledActions.includes(action) ? "secondary" : "outline"} aria-pressed={enabledActions.includes(action)} className="h-6 text-xs" onClick={() => setEnabledActions(previous => previous.includes(action) ? previous.filter(a => a !== action) : [...previous, action])}>{action}</Button>)}</div>
    {buffer.restarted && <p className="bg-state-paused/10 px-3 py-2 text-xs text-state-paused">新一次尝试，日志从头开始</p>}{buffer.text && <StaleNotice error={query.error} />}
    <div ref={viewport} onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollow(false); }} className={cn("min-h-0 overflow-auto bg-terminal px-3 py-3 font-mono text-[11px] leading-6 text-terminal-foreground", fullScreen ? "flex-1" : "h-[420px]")} aria-label="运行日志">{buffer.text ? visibleLines.length ? visibleLines.map(({ line, i, action, summary }) => {
      let event: JsonValue | undefined;
      try { event = JSON.parse(line); } catch { /* mixed output */ }
      const obj = event && typeof event === "object" && !Array.isArray(event) ? event : null;
      const displaySummary = obj && summary === line.trim() ? String(obj["summary"] ?? obj["subtype"] ?? obj["type"] ?? "事件") : summary;
      return <div key={i} data-line={i} className={cn("flex gap-3 py-0.5", search && matches[matchIndex] === i && "bg-state-paused/10")}>
        <span className="w-7 shrink-0 select-none text-right text-terminal-muted">{i + 1}</span>
        <div className="min-w-0 flex-1">{pretty ? <>
          <div className="flex items-start gap-3"><span className={cn("mt-0.5 inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 font-sans text-[11px]", actionClass[action])}>{action}</span><span className={cn("min-w-0 flex-1", wrap ? "whitespace-pre-wrap break-words" : "truncate")}><AnsiLine text={displaySummary} search={search} /></span></div>
          <details className="ml-1 text-terminal-muted"><summary className="cursor-pointer text-[10px]">原始事件</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-terminal-foreground"><AnsiLine text={event === undefined ? line : JSON.stringify(event, null, 2)} search={search} /></pre></details>
        </> : <div className={cn(wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}><AnsiLine text={line} search={search} /></div>}</div>
      </div>;
    }) : <p className="text-terminal-muted">没有符合筛选条件的日志</p> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : query.isPending ? <div className="space-y-3" aria-label="读取日志"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-1/2" /></div> : <p className="text-terminal-muted">暂无输出</p>}</div>
    <footer className="flex items-center justify-between border-t bg-surface px-3 py-2 text-[11px] text-muted-foreground"><span>{buffer.finished ? "已读完 · 停止拉取" : "每 3 秒读取"} · offset {buffer.offset} · attempt {buffer.attempt ?? run.attempt}</span>{!follow && <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => { setFollow(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }}>跳到最新 <ArrowDown /></Button>}</footer>
  </section>;
}