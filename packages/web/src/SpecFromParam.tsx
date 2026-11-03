import { useRouterState } from "@tanstack/react-router";
import { SpecDetail, type SpecSection } from "./SpecDetail.tsx";

export function SpecFromParam({
  specId,
  section,
}: {
  specId: string;
  section?: SpecSection;
}) {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const id = Number(specId);
  if (!Number.isInteger(id) || id < 1) {
    return (
      <p className="note" role="status">
        没有这个需求
      </p>
    );
  }
  return <SpecDetail specId={id} section={section} hash={hash} />;
}
