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
// kept in memory, the ones used longest ago dropped past a limit. Nothing here calls GitHub's merge endpoint;
// a person merges.

export interface GitHubOptions {
  tokens: TokenSource;
  apiUrl?: string;
  fetch?: typeof fetch;
  maxCachedResponses?: number; // how many GET responses are kept for If-None-Match; default 500
}

const PAGE_SIZE = 100; // GitHub's largest page
const MAX_PAGES = 50; // a list longer than this is refused, not judged by its first 5000

const OPEN: TokenPermissions = { pull_requests: "write", contents: "read" };
const CLOSE: TokenPermissions = { pull_requests: "write" };
// GitHub refuses the GraphQL markPullRequestReadyForReview to a token that cannot write contents too (seen on a real
// pilot repo, #92): "Resource not accessible by integration"
const MARK_READY: TokenPermissions = {
  pull_requests: "write",
  contents: "write",
};
const DELETE_BRANCH: TokenPermissions = { contents: "write" };
const READ: TokenPermissions = {
  pull_requests: "read",
  checks: "read",
  statuses: "read",
};
const BRANCH: TokenPermissions = { contents: "read" };

interface RawPull {
  number: number;
  node_id?: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  merge_commit_sha?: string | null;
  body?: string | null;
  head: { sha: string };
  mergeable?: boolean | null;
}

export function createGitHubAdapter(options: GitHubOptions): HostAdapter {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const doFetch = options.fetch ?? fetch;
  const etags = new Map<string, { etag: string; body: unknown }>();
  const maxCached = options.maxCachedResponses ?? 500;

  async function call(
    repo: RepoRef,
    permissions: TokenPermissions,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = await options.tokens.tokenFor({ repo, permissions });
    const url = `${apiUrl}/repos/${repo.owner}/${repo.name}${path}`;
    const known = method === "GET" ? etags.get(url) : undefined;
    if (known) {
      // used now: it goes to the back of the line for being dropped
      etags.delete(url);
      etags.set(url, known);
    }
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
    if (method === "GET" && response.ok && etag) {
      etags.delete(url);
      etags.set(url, { etag, body: parsed });
      for (const oldest of etags.keys()) {
        if (etags.size <= maxCached) break;
        etags.delete(oldest);
      }
    }
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

  // A list that GitHub hands out in pages of at most 100, read until a page comes back short.
  async function getPages<T>(
    repo: RepoRef,
    path: string,
    items: (body: unknown) => T[],
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = items(
        await get(repo, `${path}?per_page=${PAGE_SIZE}&page=${page}`),
      );
      all.push(...batch);
      if (batch.length < PAGE_SIZE) return all;
    }
    throw new HostError(
      `GitHub has more than ${MAX_PAGES * PAGE_SIZE} entries for ${repo.owner}/${repo.name}${path}; not judging by the first of them`,
      200,
    );
  }

  async function review(repo: RepoRef, number: number): Promise<ReviewState> {
    const reviews = await getPages(
      repo,
      `/pulls/${number}/reviews`,
      (body) => body as { user: { login: string }; state: string }[],
    );
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
    const runs = await getPages(
      repo,
      `/commits/${sha}/check-runs`,
      (body) =>
        (
          body as {
            check_runs: { status: string; conclusion: string | null }[];
          }
        ).check_runs,
    );
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

  async function mergeShas(
    repo: RepoRef,
    raw: RawPull,
  ): Promise<{ mergeSha: string | null; squashSha: string | null }> {
    const sha =
      raw.merged && typeof raw.merge_commit_sha === "string"
        ? raw.merge_commit_sha.toLowerCase()
        : "";
    if (!sha) return { mergeSha: null, squashSha: null };
    const read = await call(repo, BRANCH, "GET", `/commits/${sha}`);
    const parents = (read.body as { parents?: unknown[] } | null)?.parents;
    if (read.status === 200 && Array.isArray(parents) && parents.length <= 1)
      return { mergeSha: null, squashSha: sha };
    return { mergeSha: sha, squashSha: null };
  }

  async function info(repo: RepoRef, raw: RawPull): Promise<PullRequestInfo> {
    const shas = await mergeShas(repo, raw);
    return {
      number: raw.number,
      url: raw.html_url,
      state: raw.merged ? "merged" : raw.state,
      draft: raw.draft === true,
      headSha: raw.head.sha,
      ci: await ci(repo, raw.head.sha),
      review: await review(repo, raw.number),
      mergedBy: raw.merged_by?.login ?? null,
      mergedAt: raw.merged_at ?? null,
      mergedByPlatform: false,
      conflictsWithDefault: raw.mergeable === false,
      mergeSha: shas.mergeSha,
      squashSha: shas.squashSha,
    };
  }

  const getPullRequest: HostAdapter["getPullRequest"] = async ({
    repo,
    number,
  }) => info(repo, (await get(repo, `/pulls/${number}`)) as RawPull);

  // GraphQL is the only way to turn a draft ready. The address is next to the REST one: api.github.com/graphql, or
  // <host>/api/graphql for an enterprise server whose REST address is <host>/api/v3.
  const graphqlUrl = apiUrl.endsWith("/api/v3")
    ? `${apiUrl.slice(0, -"/api/v3".length)}/api/graphql`
    : `${apiUrl}/graphql`;

  return {
    getPullRequest,
    async getBranchSha({ repo, branch }) {
      const path = `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
      const read = await call(repo, BRANCH, "GET", path);
      const sha = (read.body as { object?: { sha?: string } }).object?.sha;
      if (read.status !== 200 || typeof sha !== "string" || sha === "")
        throw new HostError(
          `GitHub answered ${read.status} for GET ${repo.owner}/${repo.name}${path}`,
          read.status,
        );
      return sha;
    },
    async getPullRequestBody({ repo, number }) {
      const read = await call(
        repo,
        { pull_requests: "read" },
        "GET",
        `/pulls/${number}`,
      );
      if (read.status !== 200)
        throw new HostError(
          `GitHub answered ${read.status} reading pull request ${number}`,
          read.status,
        );
      return (read.body as RawPull).body ?? "";
    },
    async updatePullRequestBody({ repo, number, body }) {
      const patched = await call(repo, CLOSE, "PATCH", `/pulls/${number}`, {
        body,
      });
      if (patched.status !== 200)
        throw new HostError(
          `GitHub answered ${patched.status} updating pull request ${number}`,
          patched.status,
        );
      etags.delete(
        `${apiUrl}/repos/${repo.owner}/${repo.name}/pulls/${number}`,
      );
    },
    async markReady({ repo, number }) {
      const raw = (await get(repo, `/pulls/${number}`)) as RawPull;
      if (raw.state !== "open" || raw.merged || raw.draft !== true)
        return info(repo, raw);
      if (!raw.node_id)
        throw new HostError(
          `GitHub gave no node id for pull request ${number}`,
          502,
        );
      const token = await options.tokens.tokenFor({
        repo,
        permissions: MARK_READY,
      });
      const response = await doFetch(graphqlUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query:
            "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
          variables: { id: raw.node_id },
        }),
      });
      const answer = (await response.json().catch(() => ({}))) as {
        errors?: { message?: string }[];
      };
      if (!response.ok || answer.errors?.length) {
        const why = answer.errors?.map((e) => e.message).join("; ");
        throw new HostError(
          `GitHub refused to mark pull request ${number} ready (${response.status})${why ? `: ${why}` : ""}`,
          response.ok ? 403 : response.status,
        );
      }
      return getPullRequest({ repo, number });
    },
    async closePullRequest({ repo, number }) {
      const current = await getPullRequest({ repo, number });
      if (current.state !== "open") return current;
      const closed = await call(repo, CLOSE, "PATCH", `/pulls/${number}`, {
        state: "closed",
      });
      if (closed.status !== 200)
        throw new HostError(
          `GitHub answered ${closed.status} closing pull request ${number}`,
          closed.status,
        );
      return getPullRequest({ repo, number });
    },
    async deleteBranch({ repo, branch }) {
      // slashes stay: GitHub's ref path is refs/heads/<branch>
      const path = `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
      const deleted = await call(repo, DELETE_BRANCH, "DELETE", path);
      if (deleted.status === 204) return "deleted";
      // GitHub answers a branch that is not there with 422 "Reference does not exist"; other 422s (a protected
      // branch, ...) are refusals and must not look like success
      if (
        deleted.status === 404 ||
        (deleted.status === 422 &&
          JSON.stringify(deleted.body).includes("Reference does not exist"))
      )
        return "gone";
      throw new HostError(
        `GitHub answered ${deleted.status} deleting branch ${branch}`,
        deleted.status,
      );
    },
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
