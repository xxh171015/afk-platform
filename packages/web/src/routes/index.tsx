import { createFileRoute } from "@tanstack/react-router";
import { Workbench } from "../Workbench.tsx";

export const Route = createFileRoute("/")({
  component: Workbench,
});
