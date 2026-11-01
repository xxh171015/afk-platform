import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/specs/$specId")({
  component: SpecLayout,
});

function SpecLayout() {
  return <Outlet />;
}
