import createClient from "openapi-fetch";
import type { paths } from "./schema.d.ts";

export type { components, paths } from "./schema.d.ts";

// The one typed client for the platform API; the CLI and the web page both use it.
// `fetch` can be replaced, which is how the page's tests talk to a fake server.
export function createApiClient(
  baseUrl: string,
  fetch?: typeof globalThis.fetch,
) {
  return createClient<paths>({ baseUrl, ...(fetch ? { fetch } : {}) });
}
export type ApiClient = ReturnType<typeof createApiClient>;

// What GET /worker/jobs/{id}/bundle returns: everything a worker renders into /context.
export type Bundle =
  paths["/worker/jobs/{id}/bundle"]["get"]["responses"][200]["content"]["application/json"];

// What GET /worker/jobs/{id}/host-task returns: what a job for the code host has to do.
export type HostTask =
  paths["/worker/jobs/{id}/host-task"]["get"]["responses"][200]["content"]["application/json"];

// The acceptance pack as GET /specs/{id} returns it. Declared once, in the API; the CLI and the page read this.
export type AcceptancePackView = NonNullable<
  paths["/specs/{id}"]["get"]["responses"][200]["content"]["application/json"]["acceptancePack"]
>;
export type PullRequestRowView =
  AcceptancePackView["repos"][number]["pullRequest"] & object;
