import {
  type CiState,
  type HostAdapter,
  HostError,
  type OpenPullRequestInput,
  type PullRequestInfo,
  type PullRequestState,
  type RepoRef,
  type ReviewState,
  type TokenSource,
} from "./types.ts";

// The GitLab CE side of HostAdapter. Draft is a `Draft: ` title prefix (not /ready); close is
// `state_event=close`; a second create for the same source branch is 409 and the open pull request is returned.
// Nothing here calls GitLab's merge endpoint; a person merges. TokenPermissions are ignored: the PAT's
// user role is what counts, and the file is reread on every call. A look at an MR also reads its pipeline,
// approvals and reviewers; 429 carries Retry-After.

export interface GitLabOptions {
  tokens: TokenSource;
  apiUrl: string; // origin plus /api/v4
  fetch?: typeof fetch;
}

const DRAFT = /^draft:\s*/i;

interface RawUser {
  username?: string;
}

interface RawMr {
  iid: number;
  web_url: string;
  state: string;
  draft?: boolean;
  title?: string;
  description?: string | null;
  sha: string;
  merged_at?: string | null;
  merged_by?: RawUser | null;
  merge_user?: RawUser | null;
  head_pipeline?: { status?: string } | null;
}

const projectId = (repo: RepoRef) =>
  encodeURIComponent(`${repo.owner}/${repo.name}`);

function asState(raw: RawMr): PullRequestState {
  if (raw.state === "merged") return "merged";
  if (raw.state === "opened" || raw.state === "locked") return "open";
  return "closed";
}

function asDraft(raw: RawMr): boolean {
  return raw.draft === true || DRAFT.test(raw.title ?? "");
}

function usernameOf(user: RawUser | null | undefined): string | null {
  return typeof user?.username === "string" && user.username !== ""
    ? user.username
    : null;
}

function asCi(pipeline: RawMr["head_pipeline"]): CiState {
  const status = pipeline?.status;
  if (!status) return "none";
  if (status === "success" || status === "skipped") return "success";
  if (status === "failed" || status === "canceled") return "failure";
  return "pending";
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  if (header !== null && Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds);
  return 60;
}

function draftTitle(title: string, draft?: boolean): string {
  if (!draft || DRAFT.test(title)) return title;
  return `Draft: ${title}`;
}

function info(
  raw: RawMr,
  extra: Partial<
    Pick<
      PullRequestInfo,
      "ci" | "review" | "mergedBy" | "mergedAt" | "mergedByPlatform"
    >
  > = {},
): PullRequestInfo {
  return {
    number: raw.iid,
    url: raw.web_url,
    state: asState(raw),
    draft: asDraft(raw),
    headSha: raw.sha,
    ci: extra.ci ?? "none",
    review: extra.review ?? "none",
    mergedBy:
      extra.mergedBy ?? usernameOf(raw.merged_by) ?? usernameOf(raw.merge_user),
    mergedAt:
      extra.mergedAt ??
      (typeof raw.merged_at === "string" ? raw.merged_at : null),
    mergedByPlatform: extra.mergedByPlatform ?? false,
  };
}

export function createGitLabAdapter(options: GitLabOptions): HostAdapter {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const userByToken = new Map<string, string>();
  const canPushByKey = new Map<string, boolean>();

  async function request(
    repo: RepoRef,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = await options.tokens.tokenFor({ repo, permissions: {} });
    const response = await doFetch(url, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(
        response.headers.get("retry-after"),
      );
      throw new HostError(
        `GitLab answered 429; retry after ${retryAfterSeconds}s`,
        429,
        retryAfterSeconds,
      );
    }
    if (response.status === 204) return { status: 204, body: {} };
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed };
  }

  async function call(
    repo: RepoRef,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return request(
      repo,
      method,
      `${apiUrl}/projects/${projectId(repo)}${path}`,
      body,
    );
  }

  async function read(repo: RepoRef, iid: number): Promise<RawMr> {
    const { status, body } = await call(repo, "GET", `/merge_requests/${iid}`);
    if (status !== 200)
      throw new HostError(
        `GitLab answered ${status} for GET ${repo.owner}/${repo.name} pull request ${iid}`,
        status,
      );
    return body as RawMr;
  }

  async function optionalGet(
    repo: RepoRef,
    path: string,
  ): Promise<unknown | undefined> {
    const { status, body } = await call(repo, "GET", path);
    if (status === 404) return undefined;
    if (status !== 200)
      throw new HostError(
        `GitLab answered ${status} for GET ${repo.owner}/${repo.name}${path}`,
        status,
      );
    return body;
  }

  async function asReview(repo: RepoRef, iid: number): Promise<ReviewState> {
    const reviewers = await optionalGet(
      repo,
      `/merge_requests/${iid}/reviewers`,
    );
    if (
      Array.isArray(reviewers) &&
      reviewers.some(
        (row) => (row as { state?: string }).state === "requested_changes",
      )
    )
      return "changes-requested";
    const approvals = await optionalGet(
      repo,
      `/merge_requests/${iid}/approvals`,
    );
    const body = approvals as
      | { approved?: boolean; approved_by?: unknown[] }
      | undefined;
    if (body?.approved === true || (body?.approved_by?.length ?? 0) > 0)
      return "approved";
    return "none";
  }

  async function tokenUsername(repo: RepoRef): Promise<string> {
    const token = await options.tokens.tokenFor({ repo, permissions: {} });
    const cached = userByToken.get(token);
    if (cached !== undefined) return cached;
    const { status, body } = await request(repo, "GET", `${apiUrl}/user`);
    if (status !== 200)
      throw new HostError(`GitLab answered ${status} for GET /user`, status);
    const username = usernameOf(body as RawUser);
    if (username === null)
      throw new HostError(
        "GitLab answered 200 for GET /user without a username",
        200,
      );
    userByToken.set(token, username);
    return username;
  }

  async function canPushDefault(repo: RepoRef): Promise<boolean> {
    const token = await options.tokens.tokenFor({ repo, permissions: {} });
    const key = `${token}:${repo.owner}/${repo.name}`;
    const cached = canPushByKey.get(key);
    if (cached !== undefined) return cached;
    const project = await call(repo, "GET", "");
    if (project.status !== 200)
      throw new HostError(
        `GitLab answered ${project.status} for GET ${repo.owner}/${repo.name}`,
        project.status,
      );
    const branch =
      (project.body as { default_branch?: string }).default_branch ?? "main";
    const read = await call(
      repo,
      "GET",
      `/repository/branches/${encodeURIComponent(branch)}`,
    );
    const can =
      read.status === 200 &&
      (read.body as { can_push?: boolean }).can_push === true;
    canPushByKey.set(key, can);
    return can;
  }

  return {
    async getPullRequest({ repo, number }) {
      const raw = await read(repo, number);
      const mergedBy = usernameOf(raw.merged_by) ?? usernameOf(raw.merge_user);
      const mergedAt = typeof raw.merged_at === "string" ? raw.merged_at : null;
      let mergedByPlatform = false;
      if (asState(raw) === "merged" && mergedBy !== null) {
        const canPush = await canPushDefault(repo);
        if (!canPush)
          mergedByPlatform = mergedBy === (await tokenUsername(repo));
      }
      return info(raw, {
        ci: asCi(raw.head_pipeline),
        review: await asReview(repo, number),
        mergedBy,
        mergedAt,
        mergedByPlatform,
      });
    },
    async getPullRequestBody({ repo, number }) {
      return (await read(repo, number)).description ?? "";
    },
    async updatePullRequestBody({ repo, number, body }) {
      const patched = await call(repo, "PUT", `/merge_requests/${number}`, {
        description: body,
      });
      if (patched.status !== 200)
        throw new HostError(
          `GitLab answered ${patched.status} updating pull request ${number}`,
          patched.status,
        );
    },
    async markReady({ repo, number }) {
      const raw = await read(repo, number);
      if (asState(raw) !== "open" || !asDraft(raw)) return info(raw);
      const title = (raw.title ?? "").replace(DRAFT, "");
      if (title === (raw.title ?? "")) return info(raw);
      const patched = await call(repo, "PUT", `/merge_requests/${number}`, {
        title,
      });
      if (patched.status !== 200)
        throw new HostError(
          `GitLab answered ${patched.status} marking pull request ${number} ready`,
          patched.status,
        );
      return info(patched.body as RawMr);
    },
    async closePullRequest({ repo, number }) {
      const current = info(await read(repo, number));
      if (current.state !== "open") return current;
      const closed = await call(repo, "PUT", `/merge_requests/${number}`, {
        state_event: "close",
      });
      if (closed.status !== 200)
        throw new HostError(
          `GitLab answered ${closed.status} closing pull request ${number}`,
          closed.status,
        );
      return info(closed.body as RawMr);
    },
    async deleteBranch({ repo, branch }) {
      const deleted = await call(
        repo,
        "DELETE",
        `/repository/branches/${encodeURIComponent(branch)}`,
      );
      if (deleted.status === 204) return "deleted";
      if (deleted.status === 404) return "gone";
      throw new HostError(
        `GitLab answered ${deleted.status} deleting branch ${branch}`,
        deleted.status,
      );
    },
    async openPullRequest(input: OpenPullRequestInput) {
      const { repo } = input;
      const created = await call(repo, "POST", "/merge_requests", {
        source_branch: input.head,
        target_branch: input.base,
        title: draftTitle(input.title, input.draft),
        description: input.body,
      });
      if (created.status === 201 || created.status === 200)
        return info(created.body as RawMr);
      if (created.status === 409) {
        const found = await call(
          repo,
          "GET",
          `/merge_requests?source_branch=${encodeURIComponent(input.head)}&state=opened`,
        );
        const existing = Array.isArray(found.body)
          ? (found.body as RawMr[])[0]
          : undefined;
        if (found.status === 200 && existing) return info(existing);
      }
      throw new HostError(
        `GitLab answered ${created.status} opening a pull request for ${input.head}`,
        created.status,
      );
    },
  };
}
