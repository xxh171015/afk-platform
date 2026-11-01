import { useMemo, useState } from "react";
import { ReactFlow, Handle, Position, Controls, MiniMap, type NodeProps, type Node, type Edge as FlowEdge } from "@xyflow/react";
import { Code2, FileCode2, Network, Wrench, Cog } from "lucide-react";
import type { SpecDetailResponse, Ticket } from "@/api/types";
import { layoutSpecGraph, NODE_WIDTH, NODE_HEIGHT } from "@/lib/spec-graph";
import { ticketTypeLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Mono, ReasonBadge, RepoTag, StateBadge, ticketBorderClass, repoColorIndex } from "./badges";
import { EmptyState } from "./states";
import { SpecTicketDrawer } from "./spec-ticket-drawer";

type TicketNode = Node<{ ticket: Ticket; dimmed: boolean }, "ticket">;
const icons = { contract: FileCode2, implementation: Code2, integration: Network, fix: Wrench, system: Cog };
function TicketGraphNode({ data }: NodeProps<TicketNode>) {
  const t = data.ticket;
  const Icon = icons[t.type];
  return <div className={cn("afk-ticket-node h-[152px] w-[256px] rounded-md border border-l-[3px] bg-card p-3 text-[12px] transition-opacity", ticketBorderClass(t.state), data.dimmed && "opacity-25")}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="mb-2 flex items-center justify-between"><Mono>{t.displayId}</Mono><div className="flex items-center gap-2">{t.appended && <span className="rounded-sm border border-dashed px-1 text-[10px] text-muted-foreground">追加</span>}<Icon className="size-3.5 text-muted-foreground" aria-label={ticketTypeLabel[t.type]}><title>{ticketTypeLabel[t.type]}</title></Icon></div></div>
    <p className="mb-2 line-clamp-2 h-9 leading-[18px] font-medium">{t.title}</p><StateBadge kind="ticket" state={t.state} />
    {t.blockedReason && <div className="mt-1"><ReasonBadge reason={t.blockedReason} /></div>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
function LaneNode({ data }: NodeProps<Node<{ repo: string; tone: number }>>) { return <div className={`afk-lane afk-repo-${data.tone} h-full w-full rounded-md border`}><div className="px-4 py-3"><RepoTag name={data.repo} /></div></div>; }
const nodeTypes = { ticket: TicketGraphNode, lane: LaneNode };

export function SpecDependencyGraph({ detail, state, repo, mode, expanded = false }: { detail: SpecDetailResponse; state: string; repo: string; mode: string; expanded?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const allRepos = [...new Set([...detail.spec.repos.map(r => r.name), ...detail.tickets.map(t => t.repo)])];
  const { nodes, edges } = useMemo(() => {
    const matches = (t: Ticket) => (!state || t.state === state) && (!repo || t.repo === repo);
    const visible = mode === "filter" ? detail.tickets.filter(matches) : detail.tickets;
    const layout = layoutSpecGraph(visible, detail.edges, allRepos);
    const nodes: Node[] = layout.lanes.map((lane, i) => ({ id: `lane-${i}`, type: "lane", data: { repo: lane.repo, tone: repoColorIndex(lane.repo) }, position: { x: 0, y: lane.y }, style: { width: layout.width, height: lane.height }, selectable: false, draggable: false, zIndex: -1 }));
    nodes.push(...visible.map(t => ({ id: t.id, type: "ticket", data: { ticket: t, dimmed: !matches(t) }, position: layout.positions[t.id] ?? { x: 0, y: 0 }, width: NODE_WIDTH, height: NODE_HEIGHT, ariaLabel: `${t.displayId} ${t.title}`, draggable: false })));
    const ids = new Set(visible.map(t => t.id));
    const edges: FlowEdge[] = detail.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map((e, i) => ({ id: `edge-${i}`, source: e.from, target: e.to, type: "smoothstep", label: e.kind === "contract" ? "contract" : undefined, className: cn("afk-edge", e.kind === "contract" && "afk-edge-contract", detail.tickets.find(t => t.id === e.from)?.state === "done" && "afk-edge-done"), selectable: false }));
    return { nodes, edges };
  }, [detail.tickets, detail.edges, state, repo, mode, allRepos.join("|")]);
  if (!detail.tickets.length) return <EmptyState title="还没有票" />;
  if (!nodes.some(n => n.type === "ticket")) return <EmptyState title="没有符合筛选条件的票" />;
  return <><div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-2"><span className="w-6 border-t border-foreground" /><Mono>blocks</Mono></span><span className="flex items-center gap-2"><span className="w-6 border-t border-dashed border-foreground" /><Mono>contract</Mono></span><span className="flex items-center gap-2"><span className="afk-legend-done w-6 border-t-2" />上游已完成</span><span className="ml-auto font-mono">{nodes.filter(n => n.type === "ticket").length} tickets · {edges.length} edges</span></div>
    <div className={cn("afk-graph overflow-hidden rounded-md border bg-surface", expanded ? "h-[760px]" : "h-[640px]")} aria-label="需求依赖图"><ReactFlow key={`${detail.spec.id}-${mode}-${mode === "filter" ? state + repo : ""}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08 }} minZoom={0.2} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => { if (node.type === "ticket") setSelected(node.id); }} proOptions={{ hideAttribution: true }}><Controls position="bottom-right" showInteractive={false} /><MiniMap position="bottom-right" className="afk-minimap" pannable zoomable /></ReactFlow></div>
    <SpecTicketDrawer id={selected} detail={detail} onClose={() => setSelected(null)} />
  </>;
}