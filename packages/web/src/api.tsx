import type { ApiClient } from "@afk/shared";
import { createApiClient } from "@afk/shared";
import { createContext, type ReactNode, useContext } from "react";

// The platform API, from the one generated client the CLI uses as well. Components get it from context, so a
// test can hand them a client that talks to a fake server.
const DEFAULT_API = "http://127.0.0.1:3000";

export function apiBase(): string {
  return import.meta.env.VITE_API_URL ?? DEFAULT_API;
}

export const defaultClient = (): ApiClient => createApiClient(apiBase());

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
  const body = error as { error?: unknown; errors?: unknown } | undefined;
  if (Array.isArray(body?.errors)) return body.errors.join("\n");
  if (typeof body?.error === "string") return body.error;
  return "the request failed";
}
