import { createFileRoute } from "@tanstack/react-router";
import { SpecFromParam } from "../../../SpecFromParam.tsx";

export const Route = createFileRoute("/specs/$specId/description")({
  component: SpecDescription,
});

function SpecDescription() {
  const { specId } = Route.useParams();
  return <SpecFromParam specId={specId} section="description" />;
}
