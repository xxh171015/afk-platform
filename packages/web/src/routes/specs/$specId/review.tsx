import { createFileRoute } from "@tanstack/react-router";
import { reviewSearch } from "../../../review-search.ts";
import { SpecFromParam } from "../../../SpecFromParam.tsx";

export const Route = createFileRoute("/specs/$specId/review")({
  validateSearch: (raw: Record<string, unknown>) => reviewSearch(raw),
  component: SpecReview,
});

function SpecReview() {
  const { specId } = Route.useParams();
  return <SpecFromParam specId={specId} section="review" />;
}
