import { parseRepoUrl, type RepoRef, type TokenSource } from "@afk/host";
import type { ExecutorDeps } from "./executor.ts";

// A stage that works on a repo gets a token for it (Contents: write, nothing else) and uses it to clone, fetch and
// push. A stage can last longer than a token, so the token is renewed whenever the stage re-checks its lease just
// before a push; the cache hands back the same token until five minutes before it expires.
export interface Credentials {
  tokens: TokenSource;
  // GitHub URL -> owner and name; replaced in tests whose "GitHub" is a directory.
  repoRef?: (url: string) => RepoRef;
}

export async function withCredentials(
  deps: ExecutorDeps,
  repoUrl: string,
): Promise<ExecutorDeps> {
  if (!deps.credentials) return deps;
  const { tokens, repoRef = parseRepoUrl } = deps.credentials;
  const repo = repoRef(repoUrl);
  const mint = () =>
    tokens.tokenFor({ repo, permissions: { contents: "write" } });
  let current = await mint();
  return {
    ...deps,
    repos: deps.repos.withToken(() => current),
    push: (request) => deps.push(request, current),
    api: {
      async prePush(job) {
        const holding = await deps.api.prePush(job);
        if (holding === "held") current = await mint();
        return holding;
      },
    },
  };
}
