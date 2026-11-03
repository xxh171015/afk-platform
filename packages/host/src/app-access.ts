import { type AppTokenOptions, appJwt } from "./github-app.ts";
import { HostError, type RepoRef, type TokenPermissions } from "./types.ts";

// Whether the GitHub App can do on a repo what the platform needs (docs/design.md「bot 账号」): the repo was given
// to the App's installation, and the installation was granted these permissions. Nothing is changed on GitHub.

const NEEDED: Required<TokenPermissions> = {
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
};

export type AppAccess =
  | { state: "ok" }
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
  return missing.length > 0
    ? { state: "missing-permissions", missing, fixUrl }
    : { state: "ok" };
}
