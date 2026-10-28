import { spawnSync } from "node:child_process";

// Runs a program and keeps both its output streams. Secrets named in `redact` never appear in the output, so
// a log line or an error built from it cannot leak a token.
export interface ExecResult {
  code: number;
  out: string; // stdout and stderr together
  stdout: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  redact?: readonly string[];
}

export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): ExecResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    maxBuffer: 64 << 20,
  });
  const scrub = (text: string) =>
    (options.redact ?? []).reduce(
      (acc, secret) => (secret ? acc.split(secret).join("***") : acc),
      text,
    );
  const stdout = scrub(result.stdout ?? "");
  return {
    code: result.status ?? -1,
    out: stdout + scrub(result.stderr ?? ""),
    stdout,
  };
}

// The platform's own commits and rewrites are made by this identity.
// A commit made out of thin air (a merge candidate) has no author of its own; a clean worker may have no
// user.name configured, so it gets the platform's identity.
export const AUTHOR = {
  GIT_AUTHOR_NAME: "afk-worker",
  GIT_AUTHOR_EMAIL: "afk-worker@users.noreply.github.com",
};

const COMMITTER = {
  GIT_COMMITTER_NAME: "afk-worker",
  GIT_COMMITTER_EMAIL: "afk-worker@users.noreply.github.com",
};

export const git = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
) => exec("git", args, { cwd, env: { ...COMMITTER, ...env }, input });

export const gitOut = (cwd: string, args: string[]) =>
  git(cwd, args).stdout.trim();

export const gitOrThrow = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): string => {
  const result = git(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.out.slice(0, 400)}`,
    );
  }
  return result.stdout.trim();
};
