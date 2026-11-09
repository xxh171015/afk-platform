import { parseRepoUrl, repoHost } from "@afk/shared";
import {
  type HostAdapter,
  HostError,
  type RepoRef,
  type TokenSource,
} from "./types.ts";

// A worker has credentials for one or more code hosts (a GitHub App for github.com, a GitLab PAT per GitLab host):
// each repo's calls go to the adapter and the token source of the host it is on.

export const hostRepoRef = (url: string): RepoRef => ({
  host: repoHost(url) ?? undefined,
  ...parseRepoUrl(url),
});

function pick<T>(byHost: ReadonlyMap<string, T>, repo: RepoRef): T {
  const found = repo.host === undefined ? undefined : byHost.get(repo.host);
  if (found === undefined)
    throw new HostError(
      `this worker has no credentials for ${repo.host ?? `${repo.owner}/${repo.name}'s host`}`,
      0,
    );
  return found;
}

export function adapterByHost(
  adapters: ReadonlyMap<string, HostAdapter>,
): HostAdapter {
  const of = (repo: RepoRef) => pick(adapters, repo);
  return {
    openPullRequest: async (input) => of(input.repo).openPullRequest(input),
    getPullRequest: async (input) => of(input.repo).getPullRequest(input),
    getPullRequestBody: async (input) =>
      of(input.repo).getPullRequestBody(input),
    updatePullRequestBody: async (input) =>
      of(input.repo).updatePullRequestBody(input),
    markReady: async (input) => of(input.repo).markReady(input),
    closePullRequest: async (input) => of(input.repo).closePullRequest(input),
    deleteBranch: async (input) => of(input.repo).deleteBranch(input),
  };
}

export function tokensByHost(
  sources: ReadonlyMap<string, TokenSource>,
): TokenSource {
  return {
    tokenFor: async (request) => pick(sources, request.repo).tokenFor(request),
  };
}
