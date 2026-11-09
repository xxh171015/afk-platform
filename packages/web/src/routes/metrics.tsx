import { createFileRoute } from "@tanstack/react-router";
import { Metrics } from "../Metrics.tsx";

export const Route = createFileRoute("/metrics")({
  component: Metrics,
});
