import { exec } from "@afk/pipeline";

// Every `git push` the worker makes goes through this function, and it only lets two kinds of branch through:
// ticket branches (agent/*) and integration branches (spec/*). The platform never pushes main and has no code
// that merges a PR (docs/specs/m1-platform.md「推送出口与检测」).

// refs/heads/agent/<name> or refs/heads/spec/<name>, where the name has no empty parts, no "..", does not end
// in "/" or ".lock" (git refuses those anyway, but this exit does not rely on that).
const ALLOWED =
  /^refs\/heads\/(agent|spec)\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

// A token for git over HTTPS, with the user name its host wants beside it: a GitHub App's installation token goes
// with x-access-token (a bare string means that), a GitLab PAT with oauth2.
export type GitToken = string | { user: string; token: string };

const userAndToken = (token: GitToken) =>
  typeof token === "string" ? { user: "x-access-token", token } : token;

// The token and its encoded form: neither may appear in anything that is logged or thrown.
export const secretsOf = (credential: GitToken) => {
  const { user, token } = userAndToken(credential);
  return [token, Buffer.from(`${user}:${token}`).toString("base64")];
};

// What the host wants in the Authorization header.
export const basicAuth = (credential: GitToken) => {
  const { user, token } = userAndToken(credential);
  return `basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
};

export interface PushRequest {
  repoDir: string;
  remote?: string; // default origin
  source: string; // what to push: a commit or a ref
  target: string; // the full ref on the remote, refs/heads/agent/T-1
  // For --force-with-lease: the sha the remote branch must still have, or "" when it must not exist yet.
  // Required for every push this exit makes. Git's compare-and-swap is not a job lease.
  expectedOld?: string;
}

export interface PushOptions {
  token?: GitToken; // sent as an extra header; never written to .git/config or put in a URL, and scrubbed from output
}

export type PushResult = { ok: true } | { ok: false; error: string };

export function pushRef(
  request: PushRequest,
  options: PushOptions = {},
): PushResult {
  // An empty source would delete the remote branch: this exit never deletes.
  if (
    !request.source ||
    request.source.startsWith("-") ||
    request.source.includes(":")
  ) {
    throw new RangeError(
      `refusing to push from ${JSON.stringify(request.source)}`,
    );
  }
  if (request.remote !== undefined && request.remote !== "origin") {
    throw new RangeError(
      `refusing to push to remote ${request.remote}: only origin`,
    );
  }
  if (
    !ALLOWED.test(request.target) ||
    request.target.includes("..") ||
    request.target.endsWith(".lock")
  ) {
    throw new RangeError(
      `refusing to push ${request.target}: only refs/heads/agent/* and refs/heads/spec/*`,
    );
  }
  if (request.expectedOld === undefined) {
    throw new RangeError(
      `refusing to push ${request.target} without the SHA it is expected to have`,
    );
  }
  const header = options.token
    ? `AUTHORIZATION: ${basicAuth(options.token)}`
    : undefined;
  const compare = [
    `--force-with-lease=${request.target}:${request.expectedOld}`,
  ];
  const result = exec(
    "git",
    [
      "push",
      "--quiet",
      ...compare,
      request.remote ?? "origin",
      `${request.source}:${request.target}`,
    ],
    {
      cwd: request.repoDir,
      // in git's environment, not its arguments: argv shows in `ps`
      env: header
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: header,
          }
        : {},
      redact: options.token ? secretsOf(options.token) : [],
    },
  );
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.out.trim().slice(0, 400) };
}

// The token is the one the stage holds at the moment of the push; a PushFn that has none of its own uses it.
export type PushFn = (request: PushRequest, token?: GitToken) => PushResult;

export const pushWithToken: PushFn = (request, token) =>
  pushRef(request, token ? { token } : {});
