import createClient from "openapi-fetch";
import type { paths } from "./schema.d.ts";

export type { components, paths } from "./schema.d.ts";

// The one typed client for the platform API; the CLI and the web page both use it.
export function createApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}
export type ApiClient = ReturnType<typeof createApiClient>;
