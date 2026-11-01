import { createFileRoute, Link } from "@tanstack/react-router";
import { useSpecDetail, specPageHead } from "@/components/afk/spec-page";
import { RelativeTime } from "@/components/afk/time";
import { EmptyState } from "@/components/afk/states";
import { keepClosedTimelineEvents } from "@/lib/view-map";

export const Route = createFileRoute("/specs/$id/timeline")({
  head: ({ params }) => specPageHead(params.id, "时间线", "需求确认、运行、门禁、收尾和交付的封闭事件时间线。"),
  component: Timeline,
});
function Timeline() {
  const data = useSpecDetail();
  if (!data) return null;
  const events = keepClosedTimelineEvents(data.timeline).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!events.length) return <EmptyState title="还没有时间线事件" />;
  return <ol aria-label="需求时间线" className="max-w-4xl border-l pl-6">{events.map((event, index) => {
    const ticket = event.href?.match(/^\/tickets\/([^/]+)$/);
    const title = ticket ? <Link to="/tickets/$id" params={{ id: ticket[1] ?? "" }} className="hover:underline">{event.title}</Link> : event.href?.startsWith("https://") ? <a href={event.href} target="_blank" rel="noreferrer" className="hover:underline">{event.title}</a> : event.href ? <Link to="/specs/$id/delivery" params={{ id: data.spec.id }} className="hover:underline">{event.title}</Link> : event.title;
    return <li key={`${event.type}-${event.at}-${index}`} className="relative pb-7"><span className="absolute top-1.5 -left-[29px] size-2 rounded-full bg-primary" /><div className="flex flex-wrap items-center justify-between gap-2 text-sm"><h2 className="font-medium">{title}</h2><RelativeTime value={event.at} className="text-xs text-muted-foreground" /></div>{event.detail && <p className="mt-2 break-words whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{event.detail}</p>}</li>;
  })}</ol>;
}
