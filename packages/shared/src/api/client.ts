import createClient from "openapi-fetch";
import type { paths } from "./schema.d.ts";

export type { components, paths } from "./schema.d.ts";

// The one typed client for the platform API; the CLI and the web page both use it.
// `fetch` can be replaced, which is how the page's tests talk to a fake server.
// `headers` go with every call: the CLI says it is the CLI, so its changes are recorded as the CLI's.
export function createApiClient(
  baseUrl: string,
  fetch?: typeof globalThis.fetch,
  headers?: Record<string, string>,
) {
  return createClient<paths>({
    baseUrl,
    ...(fetch ? { fetch } : {}),
    ...(headers ? { headers } : {}),
  });
}

// The header that tells the API a call comes from `plat`.
export const CLIENT_HEADER = "x-afk-client";
// The machine plat runs on: with no login in M3 it stands in for who did it.
export const HOST_HEADER = "x-afk-host";
export const CLI_HEADERS: Record<string, string> = { [CLIENT_HEADER]: "cli" };
export type ApiClient = ReturnType<typeof createApiClient>;

// What GET /worker/jobs/{id}/bundle returns: everything a worker renders into /context.
export type Bundle =
  paths["/worker/jobs/{id}/bundle"]["get"]["responses"][200]["content"]["application/json"];

// What GET /worker/jobs/{id}/host-task returns: what a job for the code host has to do.
export type HostTask =
  paths["/worker/jobs/{id}/host-task"]["get"]["responses"][200]["content"]["application/json"];

// What GET /worker/jobs/{id}/planning-task returns: the planning commit to make (ADR 0005).
export type PlanningTask =
  paths["/worker/jobs/{id}/planning-task"]["get"]["responses"][200]["content"]["application/json"];

// What GET /worker/jobs/{id}/readiness-task returns: the branch whose gate to run (plat repo check).
export type ReadinessTask =
  paths["/worker/jobs/{id}/readiness-task"]["get"]["responses"][200]["content"]["application/json"];

// What GET /worker/jobs/{id}/trial-merge-task returns: the branches to merge-tree for a potential conflict.
export type TrialMergeTask =
  paths["/worker/jobs/{id}/trial-merge-task"]["get"]["responses"][200]["content"]["application/json"];

// The acceptance pack as GET /specs/{id} returns it. Declared once, in the API; the CLI and the page read this.
export type AcceptancePackView = NonNullable<
  paths["/specs/{id}"]["get"]["responses"][200]["content"]["application/json"]["acceptancePack"]
>;
export type PullRequestRowView =
  AcceptancePackView["repos"][number]["pullRequest"] & object;
