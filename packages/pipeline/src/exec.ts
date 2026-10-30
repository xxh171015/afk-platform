import { spawn, spawnSync } from "node:child_process";
import { redactSecrets } from "@afk/shared";

// Runs a program and keeps both its output streams. Secrets named in `redact` never appear in the output, so
// a log line or an error built from it cannot leak a token.
export interface ExecResult {
  code: number;
  out: string; // stdout and stderr together
  stdout: string;
  timedOut?: boolean; // killed because `timeoutMs` ran out
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  redact?: readonly string[];
  timeoutMs?: number; // the program is killed when it runs longer than this
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
    timeout: options.timeoutMs,
    killSignal: "SIGKILL", // a program that ignores SIGTERM must not outlive its timeout
  });
  const scrub = (text: string) => redactSecrets(text, options.redact ?? []);
  const stdout = scrub(result.stdout ?? "");
  return {
    code: result.status ?? -1,
    out: stdout + scrub(result.stderr ?? ""),
    stdout,
    ...(result.error && (result.error as { code?: string }).code === "ETIMEDOUT"
      ? { timedOut: true }
      : {}),
  };
}

export interface ExecAsyncOptions extends ExecOptions {
  signal?: AbortSignal; // the program is killed when this is aborted
}

// The same without blocking the event loop: for programs that take minutes (docker build, compose up), where the
// worker has to go on renewing its lease. The output is capped at its last 8 MiB.
const MAX_OUTPUT = 8 << 20;
export function execAsync(
  command: string,
  args: string[],
  options: ExecAsyncOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let out = "";
    let timedOut = false;
    const keep = (text: string) => text.slice(-MAX_OUTPUT);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = keep(stdout + chunk);
      out = keep(out + chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      out = keep(out + chunk);
    });
    const kill = () => child.kill("SIGKILL"); // a program that ignores SIGTERM must not outlive its timeout
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    if (options.signal?.aborted) kill();
    options.signal?.addEventListener("abort", kill, { once: true });
    const finish = (code: number) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      const scrub = (text: string) => redactSecrets(text, options.redact ?? []);
      resolve({
        code,
        out: scrub(out),
        stdout: scrub(stdout),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    child.on("error", (error) => {
      out += String(error);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    child.stdin.on("error", () => {}); // the program may exit without reading its input
    child.stdin.end(options.input ?? "");
  });
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
