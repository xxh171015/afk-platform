import { createFileRoute } from "@tanstack/react-router";
import { SpecFromParam } from "../../../SpecFromParam.tsx";

export const Route = createFileRoute("/specs/$specId/timeline")({
  component: SpecTimeline,
});

function SpecTimeline() {
  const { specId } = Route.useParams();
  return <SpecFromParam specId={specId} section="timeline" />;
}
