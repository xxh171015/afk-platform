import { parseRepoUrl, type RepoRef, type TokenSource } from "@afk/host";
import type { ExecutorDeps } from "./executor.ts";
import type { GitToken } from "./push.ts";

// A stage that works on a repo gets a token for it (Contents: write, nothing else) and uses it to clone, fetch and
// push. A stage can last longer than a token, so the token is renewed whenever the stage re-checks its lease just
// before a push; the cache hands back the same token until five minutes before it expires.
export interface Credentials {
  tokens: TokenSource;
  // GitHub URL -> owner and name; replaced in tests whose "GitHub" is a directory.
  repoRef?: (url: string) => RepoRef;
  // The user name git sends with a repo's token: oauth2 on a GitLab host; x-access-token (GitHub) when absent.
  gitUser?: (url: string) => string | undefined;
}

// `others` are the URLs of the other repos the stage reads (the ones a ticket refs, builds its environment from or takes
// its contract from): each gets a token of its own that can only read, and the clone of each is reached with it.
export async function withCredentials(
  deps: ExecutorDeps,
  repoUrl: string,
  others: readonly string[] = [],
): Promise<ExecutorDeps> {
  if (!deps.credentials) return deps;
  const { tokens, repoRef = parseRepoUrl, gitUser } = deps.credentials;
  const forGit = (url: string, token: string): GitToken => {
    const user = gitUser?.(url);
    return user ? { user, token } : token;
  };
  const readOnly = [...new Set(others)].filter((url) => url !== repoUrl);
  const mintOwn = () =>
    tokens.tokenFor({
      repo: repoRef(repoUrl),
      permissions: { contents: "write" },
    });
  const mintOthers = () =>
    Promise.all(
      readOnly.map(
        async (url) =>
          [
            url,
            await tokens.tokenFor({
              repo: repoRef(url),
              permissions: { contents: "read" },
            }),
          ] as const,
      ),
    );
  let current = await mintOwn();
  let read = new Map(await mintOthers());
  return {
    ...deps,
    repos: deps.repos.withToken((url) =>
      url === undefined || url === repoUrl
        ? forGit(repoUrl, current)
        : forGit(url, read.get(url) ?? current),
    ),
    push: (request) => deps.push(request, forGit(repoUrl, current)),
    api: {
      async prePush(job) {
        const holding = await deps.api.prePush(job);
        if (holding === "held") {
          current = await mintOwn();
          read = new Map(await mintOthers());
        }
        return holding;
      },
    },
  };
}
