import { createFileRoute } from "@tanstack/react-router";
import { Runtime } from "../Runtime.tsx";

export const Route = createFileRoute("/runtime")({
  component: Runtime,
});
