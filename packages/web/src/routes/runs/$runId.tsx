import { createFileRoute } from "@tanstack/react-router";
import { RunDetail } from "../../RunDetail.tsx";

export const Route = createFileRoute("/runs/$runId")({
  component: RunPage,
});

function RunPage() {
  const { runId } = Route.useParams();
  const id = Number(runId);
  if (!Number.isInteger(id) || id < 1) {
    return (
      <p className="note" role="status">
        没有这个 Run
      </p>
    );
  }
  return <RunDetail key={id} runId={id} />;
}
