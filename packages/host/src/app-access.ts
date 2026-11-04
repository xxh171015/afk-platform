import { SETUP_BRANCH } from "@afk/shared";
import { type AppTokenOptions, appJwt } from "./github-app.ts";
import { HostError, type RepoRef, type TokenPermissions } from "./types.ts";

// Whether the GitHub App can do on a repo what the platform needs (docs/design.md「bot 账号」): the repo was given
// to the App's installation, and the installation was granted these permissions. When it can, also which of the
// files a repo is set up with it has: on its default branch, or on afk/setup, which every spec's integration branch
// starts with until the default branch has it (ADR 0006). Nothing is changed on GitHub.

const NEEDED: Required<TokenPermissions> = {
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
};

// The files of a repo's setup that the platform reads from its default branch or afk/setup.
export const SETUP_FILES = {
  gates: ".sandcastle/gates.yaml",
  integrationCompose: ".sandcastle/integration/compose.yaml",
} as const;

export type SetupFiles = Record<keyof typeof SETUP_FILES, boolean>;

export type AppAccess =
  | { state: "ok"; files: SetupFiles }
  | { state: "not-installed"; fixUrl: string }
  | { state: "missing-permissions"; missing: string[]; fixUrl: string };

export async function checkAppAccess(
  options: AppTokenOptions,
  repo: RepoRef,
): Promise<AppAccess> {
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const asApp = (path: string, init: RequestInit = {}) =>
    doFetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${appJwt(options.credentials, now())}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
    });

  const installation = await asApp(
    `/app/installations/${options.credentials.installationId}`,
  );
  if (installation.status === 404) {
    const app = await asApp("/app");
    if (!app.ok)
      throw new HostError(
        `GitHub did not describe the App: HTTP ${app.status}`,
        app.status,
      );
    const { html_url } = (await app.json()) as { html_url: string };
    return { state: "not-installed", fixUrl: `${html_url}/installations/new` };
  }
  if (!installation.ok)
    throw new HostError(
      `GitHub did not describe the App's installation: HTTP ${installation.status}`,
      installation.status,
    );
  const { permissions, html_url: fixUrl } = (await installation.json()) as {
    permissions: Record<string, string>;
    html_url: string;
  };

  // A token limited to the repo is refused (422) when the repo was not given to the installation.
  const token = await asApp(
    `/app/installations/${options.credentials.installationId}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [repo.name],
        permissions: { metadata: "read" },
      }),
    },
  );
  if (token.status === 422 || token.status === 404)
    return { state: "not-installed", fixUrl };
  if (!token.ok)
    throw new HostError(
      `GitHub refused a token for ${repo.owner}/${repo.name}: HTTP ${token.status}`,
      token.status,
    );

  const missing = Object.entries(NEEDED)
    .filter(([name, level]) => {
      const granted = permissions[name];
      return level === "write" ? granted !== "write" : !granted;
    })
    .map(([name, level]) => `${name}: ${level}`);
  if (missing.length > 0)
    return { state: "missing-permissions", missing, fixUrl };

  // A token that can read the repo's files, now that the installation is known to have contents.
  const reader = await asApp(
    `/app/installations/${options.credentials.installationId}/access_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [repo.name],
        permissions: { contents: "read" },
      }),
    },
  );
  if (!reader.ok)
    throw new HostError(
      `GitHub refused a token to read ${repo.owner}/${repo.name}: HTTP ${reader.status}`,
      reader.status,
    );
  const { token: readToken } = (await reader.json()) as { token: string };
  // Without a ref, the contents API reads the default branch.
  const on = async (path: string, ref?: string) => {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const response = await doFetch(
      `${apiUrl}/repos/${repo.owner}/${repo.name}/contents/${path}${query}`,
      {
        headers: {
          authorization: `token ${readToken}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) return false;
    if (!response.ok)
      throw new HostError(
        `GitHub did not say whether ${repo.owner}/${repo.name} has ${path}: HTTP ${response.status}`,
        response.status,
      );
    return true;
  };
  // A missing branch is a 404 as well.
  const present = async (path: string) =>
    (await on(path)) || (await on(path, SETUP_BRANCH));
  return {
    state: "ok",
    files: {
      gates: await present(SETUP_FILES.gates),
      integrationCompose: await present(SETUP_FILES.integrationCompose),
    },
  };
}
