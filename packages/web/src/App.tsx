import {
  createMemoryHistory,
  createRouter,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export function createPlatformRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    trailingSlash: "never",
  });
}

export function App({ history }: { history?: RouterHistory } = {}) {
  const router = createPlatformRouter(
    history ?? createMemoryHistory({ initialEntries: ["/"] }),
  );
  return <RouterProvider router={router} />;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createPlatformRouter>;
  }
}
