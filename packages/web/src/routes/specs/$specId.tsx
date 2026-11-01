import { createFileRoute } from "@tanstack/react-router";
import { SpecDetail } from "../../SpecDetail.tsx";

export const Route = createFileRoute("/specs/$specId")({
  component: SpecPage,
});

function SpecPage() {
  const { specId } = Route.useParams();
  const id = Number(specId);
  if (!Number.isInteger(id) || id < 1) {
    return (
      <p className="note" role="status">
        没有这个需求
      </p>
    );
  }
  return <SpecDetail specId={id} />;
}
