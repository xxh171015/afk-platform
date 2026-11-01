import { createFileRoute } from "@tanstack/react-router";
import { Table2, GitBranch } from "lucide-react";
import { useSpecDetail, specPageHead } from "@/components/afk/spec-page";
import { SpecTickets, ticketStates } from "@/components/afk/spec-detail-panels";
import { SpecDependencyGraph } from "@/components/afk/spec-dependency-graph";
import { Mono } from "@/components/afk/badges";
import { ticketStateLabel } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/specs/$id/tickets")({
  validateSearch: (s: Record<string, unknown>): { view?: "graph"; repo?: string; state?: string } => ({
    ...(s["view"] === "graph" ? { view: "graph" as const } : {}),
    ...(typeof s["repo"] === "string" ? { repo: s["repo"] } : {}),
    ...(ticketStates.some(t => t === s["state"]) ? { state: String(s["state"]) } : {}),
  }),
  head: ({ params }) => specPageHead(params.id, "票与依赖", "按仓库与状态筛选需求票，查看表格或依赖图。"),
  component: Tickets,
});
function Tickets() {
  const data = useSpecDetail();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!data) return null;
  const patch = (key: "view" | "repo" | "state", value: string) => {
    const next = { ...search };
    if (!value || value === "all" || value === "table") delete next[key];
    else if (key === "view") next.view = "graph";
    else next[key] = value;
    void navigate({ search: next, replace: true });
  };
  return <div><div className="mb-5 flex flex-wrap items-center gap-3">
    <div className="flex gap-1 rounded-md border p-0.5" aria-label="票展示方式"><Button size="sm" variant={search.view !== "graph" ? "secondary" : "ghost"} onClick={() => patch("view", "table")} aria-pressed={search.view !== "graph"}><Table2 />表格</Button><Button size="sm" variant={search.view === "graph" ? "secondary" : "ghost"} onClick={() => patch("view", "graph")} aria-pressed={search.view === "graph"}><GitBranch />图</Button></div>
    <Select value={search.repo ?? "all"} onValueChange={v => patch("repo", v)}><SelectTrigger aria-label="仓库筛选" className="w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部仓库</SelectItem>{data.spec.repos.map(r => <SelectItem key={r.name} value={r.name}><Mono>{r.name}</Mono></SelectItem>)}</SelectContent></Select>
    <Select value={search.state ?? "all"} onValueChange={v => patch("state", v)}><SelectTrigger aria-label="状态筛选" className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{ticketStates.map(s => <SelectItem key={s} value={s}>{ticketStateLabel[s]} <Mono>{s}</Mono></SelectItem>)}</SelectContent></Select>
  </div>{search.view === "graph" ? <SpecDependencyGraph detail={data} state={search.state ?? ""} repo={search.repo ?? ""} mode="filter" /> : <SpecTickets detail={data} state={search.state ?? ""} repo={search.repo ?? ""} />}</div>;
}
