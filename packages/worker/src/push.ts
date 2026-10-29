import { exec } from "@afk/pipeline";

// Every `git push` the worker makes goes through this function, and it only lets two kinds of branch through:
// ticket branches (agent/*) and integration branches (spec/*). The platform never pushes main and has no code
// that merges a PR (docs/specs/m1-platform.md「推送出口与检测」).

// refs/heads/agent/<name> or refs/heads/spec/<name>, where the name has no empty parts, no "..", does not end
// in "/" or ".lock" (git refuses those anyway, but this exit does not rely on that).
const ALLOWED =
  /^refs\/heads\/(agent|spec)\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface PushRequest {
  repoDir: string;
  remote?: string; // default origin
  source: string; // what to push: a commit or a ref
  target: string; // the full ref on the remote, refs/heads/agent/T-1
  // For --force-with-lease: the sha the remote branch must still have, or "" when it must not exist yet.
  // Required for integration branches (spec/*): moving one without saying where it was is not allowed.
  expectedOld?: string;
}

export interface PushOptions {
  token?: string; // sent as an extra header; never written to .git/config or put in a URL, and scrubbed from output
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
  if (
    request.target.startsWith("refs/heads/spec/") &&
    request.expectedOld === undefined
  ) {
    throw new RangeError(
      `refusing to push ${request.target} without the SHA it is expected to have`,
    );
  }
  const header = options.token
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`
    : undefined;
  const lease =
    request.expectedOld === undefined
      ? []
      : [`--force-with-lease=${request.target}:${request.expectedOld}`];
  const result = exec(
    "git",
    [
      ...(header ? ["-c", `http.extraHeader=${header}`] : []),
      "push",
      "--quiet",
      ...lease,
      request.remote ?? "origin",
      `${request.source}:${request.target}`,
    ],
    {
      cwd: request.repoDir,
      redact: options.token
        ? [
            options.token,
            Buffer.from(`x-access-token:${options.token}`).toString("base64"),
          ]
        : [],
    },
  );
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.out.trim().slice(0, 400) };
}

// The token is the one the stage holds at the moment of the push; a PushFn that has none of its own uses it.
export type PushFn = (request: PushRequest, token?: string) => PushResult;

export const pushWithToken: PushFn = (request, token) =>
  pushRef(request, token ? { token } : {});
