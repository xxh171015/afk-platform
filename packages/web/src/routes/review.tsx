import { createFileRoute } from "@tanstack/react-router";
import { ReviewQueue } from "../ReviewQueue.tsx";

export const Route = createFileRoute("/review")({
  component: ReviewQueue,
});
