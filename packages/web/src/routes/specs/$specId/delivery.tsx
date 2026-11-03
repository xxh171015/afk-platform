import { createFileRoute } from "@tanstack/react-router";
import { SpecFromParam } from "../../../SpecFromParam.tsx";

export const Route = createFileRoute("/specs/$specId/delivery")({
  component: SpecDelivery,
});

function SpecDelivery() {
  const { specId } = Route.useParams();
  return <SpecFromParam specId={specId} section="delivery" />;
}
