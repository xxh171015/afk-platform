import { createApiClient } from "@afk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ApiProvider } from "./api.tsx";

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

export interface Reply {
  status?: number;
  json: unknown;
}
export type Handler = (request: { body: unknown }) => Reply | Promise<Reply>;

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
    const reply = await handler({ body: text ? JSON.parse(text) : undefined });
    return Response.json(reply.json, { status: reply.status ?? 200 });
  };
  return { calls, client: createApiClient("http://api.test", fetch) };
}

export function renderWithApp(
  ui: ReactElement,
  server: ReturnType<typeof fakeServer>,
) {
  // no polling and no retries in tests: a failed request should show up at once
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={server.client}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
}
