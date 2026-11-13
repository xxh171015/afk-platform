import { type ExecResult, execAsync } from "@afk/pipeline";

// Git that talks to origin (clone, fetch, ls-remote, push). All the jobs of a worker share one process, and a
// heartbeat is a timer in it: a git call that blocked the event loop while the network hung would let every
// job's lease run out at once. So these run without blocking, end after a time limit, and end with the job
// (lease lost, worker stopping). Git that only touches local repos stays synchronous.

// A fetch, ls-remote or push that has not finished by then is stuck, not slow.
export const REMOTE_GIT_TIMEOUT_MS = 5 * 60_000;
// A first clone moves the whole history.
export const CLONE_TIMEOUT_MS = 30 * 60_000;

export interface RemoteGitOptions {
  env?: Record<string, string>;
  redact?: readonly string[];
  signal?: AbortSignal; // the job's: git is killed when the job is given up
  timeoutMs?: number;
}

export async function remoteGit(
  cwd: string,
  args: string[],
  options: RemoteGitOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? REMOTE_GIT_TIMEOUT_MS;
  const result = await execAsync("git", args, {
    cwd,
    // never wait for a password on a terminal nobody is at
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
    redact: options.redact ?? [],
    timeoutMs,
    killGroup: true, // git leaves a fetch or push to a helper (git-remote-https), which must end with it
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // First, so that a message cut to its start keeps it. "timed out" is what classifyPushError takes for a network
  // error: a push waits and tries again, a fetch fails the job.
  const note = result.timedOut
    ? `git ${args[0]} timed out after ${timeoutMs / 1000}s`
    : options.signal?.aborted
      ? `git ${args[0]} stopped: the job was given up`
      : undefined;
  return note ? { ...result, out: `${note}\n${result.out}` } : result;
}

export async function remoteGitOrThrow(
  cwd: string,
  args: string[],
  options: RemoteGitOptions = {},
): Promise<string> {
  const result = await remoteGit(cwd, args, options);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.out.trim().slice(0, 400)}`,
    );
  }
  return result.stdout.trim();
}

// Fetches into one clone, one at a time. Two jobs on this worker can bring the same main clone up to date at once
// (synchronous git ruled that out), and two fetches writing the same refs make one fail with "cannot lock ref".
const writing = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const done = (writing.get(dir) ?? Promise.resolve()).then(work, work);
  const settled = done.catch(() => undefined);
  writing.set(dir, settled);
  void settled.then(() => {
    if (writing.get(dir) === settled) writing.delete(dir);
  });
  return done;
}
