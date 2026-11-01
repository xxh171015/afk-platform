import { createFileRoute } from "@tanstack/react-router";
import { BlockedQueue } from "../BlockedQueue.tsx";

export const Route = createFileRoute("/waiting")({
  component: BlockedQueue,
});
