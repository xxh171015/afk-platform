import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { git, hasRef } from "@afk/pipeline";
import { repoHost, tryParseRepoUrl } from "@afk/shared";
import { basicAuth, type GitToken, secretsOf } from "./push.ts";
import {
  CLONE_TIMEOUT_MS,
  oneAtATime,
  type RemoteGitOptions,
  remoteGit,
  remoteGitOrThrow,
} from "./remote-git.ts";

// Two projects can both name a repo `backend` on different hosts; a directory of just the name would fetch the
// first origin for both. Host+owner when the URL names a code host, otherwise a hash of the URL (local test paths).
function cloneDirName(name: string, url?: string): string {
  if (!url) return `${name}.git`;
  const host = repoHost(url);
  const parsed = tryParseRepoUrl(url);
  if (host && parsed) {
    return `${host}--${parsed.owner.replaceAll("/", "-")}--${name}.git`;
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${name}-${hash}.git`;
}

// The worker's main clones, one per repo, kept bare: they hold the branches every slot clone starts from.
// They follow origin for the default branch and the integration branches. Ticket branches are fetched into
// refs/afk/origin/agent/* so a diverge on origin is not silently ignored, and local heads/agent/* stay put
// until the stage aligns them.

// How a store reaches origin: the job whose calls end with it, and how long one call may take (tests shorten it).
export interface RemoteCalls {
  signal?: AbortSignal;
  timeoutMs?: number;
  cloneTimeoutMs?: number;
}

export class RepoStore {
  private readonly root: string;
  // The token for the repo at a URL: each repo has its own, since the code host gives a token to one repo at a time.
  private readonly tokenOf:
    | ((url?: string) => GitToken | undefined)
    | undefined;
  private readonly calls: RemoteCalls;

  constructor(
    root: string,
    tokenOf?: (url?: string) => GitToken | undefined,
    calls: RemoteCalls = {},
  ) {
    this.root = root;
    this.tokenOf = tokenOf;
    this.calls = calls;
  }

  // The same clones, reached with a token. It is read at each use, because a stage can outlive one token.
  withToken(tokenOf: (url?: string) => GitToken | undefined): RepoStore {
    return new RepoStore(this.root, tokenOf, this.calls);
  }

  // The same clones, for one job: a git call to origin still running when the job is given up is killed.
  during(signal: AbortSignal): RepoStore {
    return new RepoStore(this.root, this.tokenOf, { ...this.calls, signal });
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

  dirFor(name: string, url?: string): string {
    return join(this.root, cloneDirName(name, url));
  }

  // Clones on first use, then brings the branches the pipeline cares about up to date.
  ensure(name: string, url: string, defaultBranch: string): Promise<string> {
    const dir = this.dirFor(name, url);
    return oneAtATime(dir, () => this.follow(dir, url, defaultBranch));
  }

  private async follow(
    dir: string,
    url: string,
    defaultBranch: string,
  ): Promise<string> {
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      // a clone killed half way leaves a directory behind: it only takes the clone's name once it is whole
      const partial = `${dir}.partial`;
      rmSync(partial, { recursive: true, force: true });
      await this.run(
        this.root,
        ["clone", "--quiet", "--bare", url, partial],
        url,
        { timeoutMs: this.calls.cloneTimeoutMs ?? CLONE_TIMEOUT_MS },
      );
      renameSync(partial, dir);
    }
    // '+' for the branches origin owns; a failure here means the default branch or the integration branch is
    // stale, so it is an error, not something to carry on with.
    await this.run(
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
    // Origin's ticket branches, without moving the local heads a stage may still need to push.
    await remoteGit(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        "+refs/heads/agent/*:refs/afk/origin/agent/*",
      ],
      this.options(url),
    );
    return dir;
  }

  // A clone already on disk for this origin, if this worker has one.
  findByUrl(url: string): string | undefined {
    if (!existsSync(this.root)) return undefined;
    for (const name of readdirSync(this.root)) {
      if (name.endsWith(".partial")) continue; // a clone that never finished
      const dir = join(this.root, name);
      if (git(dir, ["rev-parse", "--is-bare-repository"]).code !== 0) continue;
      if (git(dir, ["remote", "get-url", "origin"]).stdout.trim() === url)
        return dir;
    }
    return undefined;
  }

  // A git call to origin with the token, which is scrubbed from what it says, under this store's limits.
  private options(url?: string, over: RemoteGitOptions = {}): RemoteGitOptions {
    const token = this.tokenOf?.(url);
    return {
      env: this.env(url),
      redact: token ? secretsOf(token) : [],
      ...(this.calls.signal ? { signal: this.calls.signal } : {}),
      ...(this.calls.timeoutMs ? { timeoutMs: this.calls.timeoutMs } : {}),
      ...over,
    };
  }

  private run(
    cwd: string,
    args: string[],
    url?: string,
    over: RemoteGitOptions = {},
  ): Promise<string> {
    return remoteGitOrThrow(cwd, args, this.options(url, over));
  }

  // One branch that ensure() does not follow (afk/setup, for `plat repo check`); false when origin has no such branch.
  async fetchBranch(
    dir: string,
    url: string,
    branch: string,
  ): Promise<boolean> {
    const found = await this.run(
      dir,
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      url,
    );
    if (found.trim() === "") return false;
    await oneAtATime(dir, () =>
      this.run(
        dir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${branch}:refs/heads/${branch}`,
        ],
        url,
      ),
    );
    return true;
  }

  has(dir: string, ref: string): boolean {
    return hasRef(dir, ref);
  }

  hasObject(dir: string, sha: string): boolean {
    return git(dir, ["cat-file", "-t", sha]).stdout.trim() === "commit";
  }

  // A planning commit may live only on plan/*, which ensure() does not fetch.
  async fetchObject(dir: string, url: string, sha: string): Promise<void> {
    if (this.hasObject(dir, sha)) return;
    // origin may just not have it under that name; a fetch that timed out says so instead
    let failure = "";
    for (const refspec of [sha, "+refs/heads/plan/*:refs/heads/plan/*"]) {
      try {
        await oneAtATime(dir, () =>
          this.run(
            dir,
            ["fetch", "--quiet", "--no-tags", "origin", refspec],
            url,
          ),
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (this.hasObject(dir, sha)) return;
    }
    throw new Error(
      `planning commit ${sha} is not on origin${/timed out/.test(failure) ? ` (${failure})` : ""}`,
    );
  }
}
