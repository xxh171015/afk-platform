// The code host (GitHub or GitLab CE) as the platform sees it: it opens a pull request and reads one
// back. It has no call that merges one: a person does that on the host (docs/design.md「代码托管」).

import type { RepoRef } from "@afk/shared";

export { parseRepoUrl } from "@afk/shared";
export type { RepoRef };

// GitHub's permission names; the access level a token is asked for. A token is asked for what one job needs.
export type TokenPermissions = Partial<
  Record<"contents" | "pull_requests" | "checks" | "statuses", "read" | "write">
>;

export interface TokenRequest {
  repo: RepoRef;
  permissions: TokenPermissions;
}

// Where a token comes from. GitHub: an installation token exchanged with the App's private key. GitLab: a PAT
// reread from ~/.afk/secrets/gitlab/<host> on every call (TokenPermissions are ignored). Everything that needs a
// token asks this and nothing else.
export interface TokenSource {
  tokenFor(request: TokenRequest): Promise<string>;
}

export type CiState = "none" | "pending" | "success" | "failure";
export type ReviewState = "none" | "approved" | "changes-requested";
export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestInfo {
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
  headSha: string;
  ci: CiState;
  review: ReviewState;
  // Who the host says merged it, and when (ISO). mergedByPlatform is the token's user, and only when that
  // user cannot push the default branch (a bot). A personal token would flag every merge a person makes.
  mergedBy: string | null;
  mergedAt: string | null;
  mergedByPlatform: boolean;
}

export interface OpenPullRequestInput {
  repo: RepoRef;
  head: string; // the branch with the changes, spec/<id>/<slug>
  base: string; // the branch they are meant for
  title: string;
  body: string;
  draft?: boolean;
}

export interface HostAdapter {
  // Opening twice for the same branch returns the pull request that is already there.
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestInfo>;
  getPullRequest(input: {
    repo: RepoRef;
    number: number;
  }): Promise<PullRequestInfo>;
  // The current description, so a PATCH can keep what a person wrote outside the platform's markers.
  getPullRequestBody(input: { repo: RepoRef; number: number }): Promise<string>;
  // Writes the description. Pull requests:write is enough; this never merges.
  updatePullRequestBody(input: {
    repo: RepoRef;
    number: number;
    body: string;
  }): Promise<void>;
  // Turns a draft pull request into one that is ready for review. One that is not a draft (a person got there
  // first) is returned as it is, nothing is sent.
  markReady(input: { repo: RepoRef; number: number }): Promise<PullRequestInfo>;
  // Closes the pull request without merging it. One that is not open (already closed, merged) is returned as it
  // is, nothing is sent: closing never undoes a merge.
  closePullRequest(input: {
    repo: RepoRef;
    number: number;
  }): Promise<PullRequestInfo>;
  // "gone" when the branch was not there: deleting twice is not a failure.
  deleteBranch(input: {
    repo: RepoRef;
    branch: string;
  }): Promise<"deleted" | "gone">;
}

// A call the host refused or could not answer. The message never holds a token. 429 carries Retry-After so
// the next host-sync can wait that long.
export class HostError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "HostError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
