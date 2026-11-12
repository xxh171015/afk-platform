import { createApiClient } from "@afk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createPlatformRouter } from "./App.tsx";
import { ApiProvider } from "./api.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";

// jsdom has no layout engine; React Flow asks for these.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??=
  FakeResizeObserver as unknown as typeof ResizeObserver;
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView ??= () => {};
}
if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}

export interface Reply {
  status?: number;
  json: unknown;
}
export type Handler = (request: {
  body: unknown;
  url: URL;
}) => Reply | Promise<Reply>;

export const emptyWaiting = {
  tickets: [] as unknown[],
  finalizations: [] as unknown[],
  pullRequests: [] as unknown[],
  cleanups: [] as unknown[],
  readyFailures: [] as unknown[],
  planning: [] as unknown[],
  specs: [] as unknown[],
  items: [] as unknown[],
};

export const emptyWorkbench = {
  waiting: emptyWaiting,
  running: [] as unknown[],
  awaitingAcceptance: [] as unknown[],
  recentlyCompleted: [] as unknown[],
  status: {
    agentsPaused: null as { since: string; reason: string } | null,
    logDirBytes: 0,
    apiFreeBytes: 20 * 1024 ** 3,
    diskLevel: "ok" as const,
    warnGib: 10,
    stopGib: 5,
    lastCleanup: { at: null as string | null, runs: 0, orphans: 0 },
    feishu: {
      open: false as boolean,
      closedReason: "missing" as "missing" | "permissions" | "invalid" | null,
    },
    workers: [] as Array<{
      id: string;
      reportedAt: string;
      freeBytes: number | null;
      cleaned: { sandboxLogs: number; salvage: number; snapshots: number };
    }>,
  },
};

// A stand-in for the platform API: `routes` maps "METHOD /path" to what it answers. Every call is recorded.
export function fakeServer(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fetch = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler)
      return Response.json({ error: `no route ${key}` }, { status: 404 });
    const text = request.method === "GET" ? "" : await request.text();
    const reply = await handler({
      body: text ? JSON.parse(text) : undefined,
      url: new URL(request.url),
    });
    return Response.json(reply.json, { status: reply.status ?? 200 });
  };
  return { calls, client: createApiClient("http://api.test", fetch) };
}

function providers(server: ReturnType<typeof fakeServer>, child: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return {
    queryClient,
    tree: (
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={server.client}>
          <TooltipProvider>{child}</TooltipProvider>
        </ApiProvider>
      </QueryClientProvider>
    ),
  };
}

export function renderWithApp(
  ui: ReactElement,
  server: ReturnType<typeof fakeServer>,
) {
  const { queryClient, tree } = providers(server, ui);
  return { ...render(tree), queryClient };
}

export function renderApp(server: ReturnType<typeof fakeServer>, path = "/") {
  const router = createPlatformRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  const { queryClient, tree } = providers(
    server,
    <RouterProvider router={router} />,
  );
  return { ...render(tree), queryClient, router };
}
