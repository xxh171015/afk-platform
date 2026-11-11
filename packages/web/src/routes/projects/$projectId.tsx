import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettings } from "../../ProjectSettings.tsx";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const id = Number(projectId);
  if (!Number.isInteger(id) || id < 1) {
    return (
      <p className="note" role="status">
        没有这个项目
      </p>
    );
  }
  return <ProjectSettings key={id} projectId={id} />;
}
