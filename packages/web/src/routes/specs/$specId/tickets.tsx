import { createFileRoute } from "@tanstack/react-router";
import { SpecFromParam } from "../../../SpecFromParam.tsx";

export const Route = createFileRoute("/specs/$specId/tickets")({
  component: SpecTickets,
});

function SpecTickets() {
  const { specId } = Route.useParams();
  return <SpecFromParam specId={specId} section="tickets" />;
}
