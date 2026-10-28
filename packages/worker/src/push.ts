import { exec } from "@afk/pipeline";

// Every `git push` the worker makes goes through this function, and it only lets two kinds of branch through:
// ticket branches (agent/*) and integration branches (spec/*). The platform never pushes main and has no code
// that merges a PR (docs/specs/m1-platform.md「推送出口与检测」).

const ALLOWED = /^refs\/heads\/(agent|spec)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface PushRequest {
  repoDir: string;
  remote?: string; // default origin
  source: string; // what to push: a commit or a ref
  target: string; // the full ref on the remote, refs/heads/agent/T-1
  expectedOld?: string; // for --force-with-lease: the sha the remote branch must still have
}

export interface PushOptions {
  token?: string; // sent as an extra header; never written to .git/config or put in a URL, and scrubbed from output
}

export type PushResult = { ok: true } | { ok: false; error: string };

export function pushRef(
  request: PushRequest,
  options: PushOptions = {},
): PushResult {
  if (!ALLOWED.test(request.target) || request.target.includes("..")) {
    throw new RangeError(
      `refusing to push ${request.target}: only refs/heads/agent/* and refs/heads/spec/*`,
    );
  }
  const header = options.token
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`
    : undefined;
  const lease = request.expectedOld
    ? [`--force-with-lease=${request.target}:${request.expectedOld}`]
    : [];
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

export type PushFn = (request: PushRequest) => PushResult;
