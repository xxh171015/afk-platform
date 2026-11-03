import { createRootRoute } from "@tanstack/react-router";
import { Layout } from "../Layout.tsx";

export const Route = createRootRoute({
  component: Layout,
  notFoundComponent: () => (
    <p className="note" role="status">
      没有这个页面
    </p>
  ),
});
