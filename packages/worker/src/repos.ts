import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitOrThrow, hasRef } from "@afk/pipeline";
import { redactSecrets } from "@afk/shared";
import { basicAuth, secretsOf } from "./push.ts";

// The worker's main clones, one per repo, kept bare: they hold the branches every slot clone starts from.
// They follow origin for the default branch and the integration branches; ticket branches only move forward.

export class RepoStore {
  private readonly root: string;
  // The token for the repo at a URL: each repo has its own, since the code host gives a token to one repo at a time.
  private readonly tokenOf: ((url?: string) => string | undefined) | undefined;

  constructor(root: string, tokenOf?: (url?: string) => string | undefined) {
    this.root = root;
    this.tokenOf = tokenOf;
  }

  // The same clones, reached with a token. It is read at each use, because a stage can outlive one token.
  withToken(tokenOf: (url?: string) => string | undefined): RepoStore {
    return new RepoStore(this.root, tokenOf);
  }

  // The token goes to git in its environment as an extra header: not in the URL, not in .git/config, not in argv.
  private env(url?: string): Record<string, string> {
    const token = this.tokenOf?.(url);
    if (!token) return {};
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${basicAuth(token)}`,
    };
  }

  dirFor(name: string): string {
    return join(this.root, `${name}.git`);
  }

  // Clones on first use, then brings the branches the pipeline cares about up to date.
  ensure(name: string, url: string, defaultBranch: string): string {
    const dir = this.dirFor(name);
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      this.run(this.root, ["clone", "--quiet", "--bare", url, dir], url);
    }
    // '+' for the branches origin owns; a failure here means the default branch or the integration branch is
    // stale, so it is an error, not something to carry on with.
    this.run(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
        "+refs/heads/spec/*:refs/heads/spec/*",
      ],
      url,
    );
    // Ticket branches only move forward and can hold work origin has not seen: a refused update is fine.
    git(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        "refs/heads/agent/*:refs/heads/agent/*",
      ],
      this.env(url),
    );
    return dir;
  }

  // gitOrThrow with the token scrubbed from the message it throws.
  private run(cwd: string, args: string[], url?: string): string {
    try {
      return gitOrThrow(cwd, args, this.env(url));
    } catch (error) {
      const token = this.tokenOf?.(url);
      if (!token || !(error instanceof Error)) throw error;
      throw new Error(redactSecrets(error.message, secretsOf(token)));
    }
  }

  has(dir: string, ref: string): boolean {
    return hasRef(dir, ref);
  }
}
