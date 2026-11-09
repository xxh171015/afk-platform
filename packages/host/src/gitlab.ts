import {
  type HostAdapter,
  HostError,
  type OpenPullRequestInput,
  type PullRequestInfo,
  type PullRequestState,
  type RepoRef,
  type TokenSource,
} from "./types.ts";

// The GitLab CE side of HostAdapter. Draft is a `Draft: ` title prefix (not /ready); close is
// `state_event=close`; a second create for the same source branch is 409 and the open pull request is returned.
// Nothing here calls GitLab's merge endpoint; a person merges. TokenPermissions are ignored: the PAT's
// user role is what counts, and the file is reread on every call.

export interface GitLabOptions {
  tokens: TokenSource;
  apiUrl: string; // origin plus /api/v4
  fetch?: typeof fetch;
}

const DRAFT = /^draft:\s*/i;

interface RawMr {
  iid: number;
  web_url: string;
  state: string;
  draft?: boolean;
  title?: string;
  description?: string | null;
  sha: string;
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

function info(raw: RawMr): PullRequestInfo {
  return {
    number: raw.iid,
    url: raw.web_url,
    state: asState(raw),
    draft: asDraft(raw),
    headSha: raw.sha,
    ci: "none",
    review: "none",
  };
}

function draftTitle(title: string, draft?: boolean): string {
  if (!draft || DRAFT.test(title)) return title;
  return `Draft: ${title}`;
}

export function createGitLabAdapter(options: GitLabOptions): HostAdapter {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call(
    repo: RepoRef,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = await options.tokens.tokenFor({ repo, permissions: {} });
    const response = await doFetch(
      `${apiUrl}/projects/${projectId(repo)}${path}`,
      {
        method,
        headers: {
          "PRIVATE-TOKEN": token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (response.status === 204) return { status: 204, body: {} };
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed };
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

  return {
    async getPullRequest({ repo, number }) {
      return info(await read(repo, number));
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
