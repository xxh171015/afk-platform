import { SETUP_BRANCH } from "@afk/shared";
import { SETUP_FILES, type SetupFiles } from "./app-access.ts";
import { HostError, type RepoRef, type TokenSource } from "./types.ts";

// Whether a GitLab PAT can do on a repo what the platform needs (docs/specs/m3-platform.md「托管类型与接入」):
// the token's user is a project member (red if not); can_push on the default branch and Developers-can-merge
// are M3 hints only. When the user is a member, also which setup files the default branch or afk/setup has.

const DEVELOPER = 30;

export type GitLabAccessHint = "personal-token" | "developers-can-merge";

export type GitLabAccess =
  | {
      state: "ok";
      username: string;
      hints: GitLabAccessHint[];
      files: SetupFiles;
      // omitted when GitLab did not say; null when the PAT has no expiry
      tokenExpiresAt?: string | null;
    }
  | {
      state: "not-member";
      username: string;
      fix: string;
      hints: [];
      tokenExpiresAt?: string | null;
    };

export interface GitLabAccessOptions {
  tokens: TokenSource;
  apiUrl: string; // origin plus /api/v4
  fetch?: typeof fetch;
}

export type GitLabTokenIdentity = {
  username: string;
  userId: number;
  // omitted when GitLab did not say; null when the PAT has no expiry
  tokenExpiresAt?: string | null;
};

const projectId = (repo: RepoRef) =>
  encodeURIComponent(`${repo.owner}/${repo.name}`);

function notMemberFix(username: string): string {
  return `请项目 Maintainer 把〈${username}〉加为 Developer`;
}

function gitlabGet(apiUrl: string, token: string, doFetch: typeof fetch) {
  return async (path: string) => {
    const response = await doFetch(`${apiUrl}${path}`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    const body: unknown = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };
}

// The PAT's user and expiry, from GET /user and GET /personal_access_tokens/self. No repo is needed.
export async function describeGitLabToken(options: {
  token: string;
  apiUrl: string;
  fetch?: typeof fetch;
}): Promise<GitLabTokenIdentity> {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const get = gitlabGet(apiUrl, options.token, options.fetch ?? fetch);
  const user = await get("/user");
  if (user.status !== 200)
    throw new HostError(
      `GitLab did not describe the token's user: HTTP ${user.status}`,
      user.status,
    );
  const username =
    typeof (user.body as { username?: unknown }).username === "string"
      ? (user.body as { username: string }).username
      : "";
  const userId = (user.body as { id?: unknown }).id;
  if (username === "" || typeof userId !== "number")
    throw new HostError("GitLab did not name the token's user", user.status);

  const expiry = await get("/personal_access_tokens/self");
  const tokenExpiresAt = (() => {
    if (expiry.status !== 200) return undefined;
    const value = (expiry.body as { expires_at?: unknown }).expires_at;
    if (value === null) return null;
    return typeof value === "string" ? value : undefined;
  })();

  return {
    username,
    userId,
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
  };
}

export async function checkGitLabAccess(
  options: GitLabAccessOptions,
  repo: RepoRef,
): Promise<GitLabAccess> {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const token = await options.tokens.tokenFor({ repo, permissions: {} });
  const get = gitlabGet(apiUrl, token, doFetch);
  const { username, userId, tokenExpiresAt } = await describeGitLabToken({
    token,
    apiUrl,
    fetch: doFetch,
  });

  const member = await get(
    `/projects/${projectId(repo)}/members/all/${userId}`,
  );
  if (member.status === 404)
    return {
      state: "not-member",
      username,
      fix: notMemberFix(username),
      hints: [],
      ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
    };
  if (member.status !== 200)
    throw new HostError(
      `GitLab did not say whether ${username} is a member of ${repo.owner}/${repo.name}: HTTP ${member.status}`,
      member.status,
    );

  const project = await get(`/projects/${projectId(repo)}`);
  if (project.status !== 200)
    throw new HostError(
      `GitLab did not describe ${repo.owner}/${repo.name}: HTTP ${project.status}`,
      project.status,
    );
  const defaultBranch =
    typeof (project.body as { default_branch?: unknown }).default_branch ===
    "string"
      ? (project.body as { default_branch: string }).default_branch
      : "master";

  const branch = await get(
    `/projects/${projectId(repo)}/repository/branches/${encodeURIComponent(defaultBranch)}`,
  );
  if (branch.status !== 200)
    throw new HostError(
      `GitLab did not describe ${repo.owner}/${repo.name} ${defaultBranch}: HTTP ${branch.status}`,
      branch.status,
    );
  const canPush = (branch.body as { can_push?: unknown }).can_push === true;

  const protectedBranch = await get(
    `/projects/${projectId(repo)}/protected_branches/${encodeURIComponent(defaultBranch)}`,
  );
  const developersCanMerge = (() => {
    if (protectedBranch.status === 404) return true;
    if (protectedBranch.status !== 200)
      throw new HostError(
        `GitLab did not describe protection of ${repo.owner}/${repo.name} ${defaultBranch}: HTTP ${protectedBranch.status}`,
        protectedBranch.status,
      );
    const levels = (protectedBranch.body as { merge_access_levels?: unknown })
      .merge_access_levels;
    if (!Array.isArray(levels)) return false;
    return levels.some((level) => {
      if (typeof level !== "object" || level === null) return false;
      const row = level as {
        access_level?: unknown;
        user_id?: unknown;
        group_id?: unknown;
      };
      if (row.user_id != null || row.group_id != null) return false;
      return (
        typeof row.access_level === "number" &&
        row.access_level > 0 &&
        row.access_level <= DEVELOPER
      );
    });
  })();

  const hints: GitLabAccessHint[] = [
    ...(canPush ? (["personal-token"] as const) : []),
    ...(developersCanMerge ? (["developers-can-merge"] as const) : []),
  ];

  const on = async (path: string, ref: string) => {
    const response = await get(
      `/projects/${projectId(repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (response.status === 404) return false;
    if (response.status !== 200)
      throw new HostError(
        `GitLab did not say whether ${repo.owner}/${repo.name} has ${path}: HTTP ${response.status}`,
        response.status,
      );
    return true;
  };
  const present = async (path: string) =>
    (await on(path, defaultBranch)) || (await on(path, SETUP_BRANCH));

  return {
    state: "ok",
    username,
    hints,
    files: {
      gates: await present(SETUP_FILES.gates),
      integrationCompose: await present(SETUP_FILES.integrationCompose),
    },
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
  };
}
