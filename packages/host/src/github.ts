import {
  type CiState,
  type HostAdapter,
  HostError,
  type OpenPullRequestInput,
  type PullRequestInfo,
  type RepoRef,
  type ReviewState,
  type TokenPermissions,
  type TokenSource,
} from "./types.ts";

// The GitHub side of HostAdapter. Reads are conditional (If-None-Match): GitHub answers 304 without counting
// against the rate limit when nothing changed, which is what a poll every minute mostly finds. The ETags are
// kept in memory for the life of the process. Nothing here calls GitHub's merge endpoint; a person merges.

export interface GitHubOptions {
  tokens: TokenSource;
  apiUrl?: string;
  fetch?: typeof fetch;
}

const OPEN: TokenPermissions = { pull_requests: "write", contents: "read" };
const READ: TokenPermissions = {
  pull_requests: "read",
  checks: "read",
  statuses: "read",
};

interface RawPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  head: { sha: string };
}

export function createGitHubAdapter(options: GitHubOptions): HostAdapter {
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const etags = new Map<string, { etag: string; body: unknown }>();

  async function call(
    repo: RepoRef,
    permissions: TokenPermissions,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = await options.tokens.tokenFor({ repo, permissions });
    const url = `${apiUrl}/repos/${repo.owner}/${repo.name}${path}`;
    const known = method === "GET" ? etags.get(url) : undefined;
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(known ? { "if-none-match": known.etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 304 && known)
      return { status: 200, body: known.body };
    const parsed = await response.json().catch(() => ({}));
    const etag = response.headers.get("etag");
    if (method === "GET" && response.ok && etag)
      etags.set(url, { etag, body: parsed });
    return { status: response.status, body: parsed };
  }

  const get = async (repo: RepoRef, path: string) => {
    const { status, body } = await call(repo, READ, "GET", path);
    if (status !== 200)
      throw new HostError(
        `GitHub answered ${status} for GET ${repo.owner}/${repo.name}${path}`,
        status,
      );
    return body;
  };

  async function review(repo: RepoRef, number: number): Promise<ReviewState> {
    const reviews = (await get(
      repo,
      `/pulls/${number}/reviews?per_page=100`,
    )) as { user: { login: string }; state: string }[];
    // What counts is each reviewer's latest verdict; a comment does not take back an approval.
    const latest = new Map<string, string>();
    for (const r of reviews)
      if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
        latest.set(r.user.login, r.state);
    const verdicts = [...latest.values()];
    if (verdicts.includes("CHANGES_REQUESTED")) return "changes-requested";
    return verdicts.includes("APPROVED") ? "approved" : "none";
  }

  async function ci(repo: RepoRef, sha: string): Promise<CiState> {
    const runs = (
      (await get(repo, `/commits/${sha}/check-runs?per_page=100`)) as {
        check_runs: { status: string; conclusion: string | null }[];
      }
    ).check_runs;
    const status = (await get(repo, `/commits/${sha}/status`)) as {
      state: string;
      total_count: number;
    };
    const states: CiState[] = runs.map((run) => {
      if (run.status !== "completed") return "pending";
      return ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
        ? "success"
        : "failure";
    });
    if (status.total_count > 0)
      states.push(
        status.state === "success"
          ? "success"
          : status.state === "pending"
            ? "pending"
            : "failure",
      );
    if (states.length === 0) return "none";
    if (states.includes("failure")) return "failure";
    return states.includes("pending") ? "pending" : "success";
  }

  async function info(repo: RepoRef, raw: RawPull): Promise<PullRequestInfo> {
    return {
      number: raw.number,
      url: raw.html_url,
      state: raw.merged ? "merged" : raw.state,
      draft: raw.draft === true,
      headSha: raw.head.sha,
      ci: await ci(repo, raw.head.sha),
      review: await review(repo, raw.number),
    };
  }

  const getPullRequest: HostAdapter["getPullRequest"] = async ({
    repo,
    number,
  }) => info(repo, (await get(repo, `/pulls/${number}`)) as RawPull);

  return {
    getPullRequest,
    async openPullRequest(input: OpenPullRequestInput) {
      const { repo } = input;
      const created = await call(repo, OPEN, "POST", "/pulls", {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft ?? false,
      });
      if (created.status === 201) return info(repo, created.body as RawPull);
      // A second try after the first one got through (the answer was lost): the pull request is already there.
      if (
        created.status === 422 &&
        JSON.stringify(created.body).includes("already exists")
      ) {
        const found = await call(
          repo,
          OPEN,
          "GET",
          `/pulls?head=${encodeURIComponent(`${repo.owner}:${input.head}`)}&state=open`,
        );
        const existing = (found.body as RawPull[])[0];
        if (found.status === 200 && existing)
          return getPullRequest({ repo, number: existing.number });
      }
      throw new HostError(
        `GitHub answered ${created.status} opening a pull request for ${input.head}`,
        created.status,
      );
    },
  };
}
