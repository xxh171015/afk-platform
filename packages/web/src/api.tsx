import type { ApiClient } from "@afk/shared";
import { createApiClient } from "@afk/shared";
import { createContext, type ReactNode, useContext } from "react";

// The platform API, from the one generated client the CLI uses as well. Components get it from context, so a
// test can hand them a client that talks to a fake server.
const DEFAULT_API = "http://127.0.0.1:3000";

export function apiBase(): string {
  return import.meta.env.VITE_API_URL ?? DEFAULT_API;
}

// React Query will not start a new fetch while one is in flight, including on
// window focus. A request that never returns (API restarted under the tab)
// would leave the page on its skeleton. Time out so it can fail and retry.
const FETCH_MS = 10_000;

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_MS);
  const signal =
    init?.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeout])
      : (init?.signal ?? timeout);
  return fetch(input, { ...init, signal });
}

export const defaultClient = (): ApiClient =>
  createApiClient(apiBase(), fetchWithTimeout);

const Context = createContext<ApiClient | undefined>(undefined);

export function ApiProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(Context);
  if (!client) throw new Error("useApi needs an ApiProvider");
  return client;
}

// What the API said when it refused, in words.
export function describeError(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name
      : error && typeof error === "object" && "name" in error
        ? String((error as { name: unknown }).name)
        : "";
  if (name === "AbortError" || name === "TimeoutError") return "请求超时";
  const body = error as { error?: unknown; errors?: unknown } | undefined;
  if (Array.isArray(body?.errors)) return body.errors.join("\n");
  if (typeof body?.error === "string") return body.error;
  return "the request failed";
}
