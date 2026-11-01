import { createFileRoute } from "@tanstack/react-router";
import { useSpecDetail, specPageHead } from "@/components/afk/spec-page";
export const Route = createFileRoute("/specs/$id/description")({
  head: ({ params }) => specPageHead(params.id, "需求说明", "需求正文与业务说明。"),
  component: Description,
});
function Description() {
  const data = useSpecDetail();
  return data ? <article aria-label="需求说明" className="max-w-4xl whitespace-pre-wrap text-sm leading-8">{data.spec.body}</article> : null;
}
