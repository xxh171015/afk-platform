import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { committedShasFromBlame, parseTrailers } from "@afk/shared";

// Local git half of `plat context --files`: blame in the person's checkout, skip
// uncommitted lines, parse Spec/Ticket/Run trailers. The API then completes Links.

export interface BlamedCommit {
  sha: string;
  spec?: string;
  ticket?: string;
  run?: string;
}

export interface BlamedFile {
  path: string;
  commits: BlamedCommit[];
}

export interface ContextCheckout {
  origin: string | null;
  files: BlamedFile[];
}

function git(
  cwd: string,
  args: string[],
): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trimEnd(),
    err: (result.stderr ?? "").trimEnd(),
  };
}

function gitPath(top: string, cwd: string, given: string): string {
  const abs = resolve(cwd, given);
  const rel = relative(top, abs);
  return rel.split("\\").join("/");
}

function commitsFor(top: string, shas: string[]): BlamedCommit[] {
  const commits: BlamedCommit[] = [];
  for (const sha of shas) {
    const message = git(top, ["log", "-1", "--format=%B", sha]);
    const trailers = message.ok ? parseTrailers(message.out) : {};
    commits.push({
      sha,
      ...(trailers.spec ? { spec: trailers.spec } : {}),
      ...(trailers.ticket ? { ticket: trailers.ticket } : {}),
      ...(trailers.run ? { run: trailers.run } : {}),
    });
  }
  return commits;
}

export function inspectContextCheckout(
  cwd: string,
  paths: string[],
): ContextCheckout | { error: string } {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: "not a git checkout" };
  const root = top.out.trim();
  const origin = git(root, ["config", "--get", "remote.origin.url"]);
  const files: BlamedFile[] = [];
  for (const given of paths) {
    const path = gitPath(root, cwd, given);
    if (path.startsWith("..")) continue;
    const blamed = git(root, ["blame", "--porcelain", "--", path]);
    if (!blamed.ok) continue;
    const shas = committedShasFromBlame(blamed.out);
    files.push({ path: given, commits: commitsFor(root, shas) });
  }
  return {
    origin: origin.ok && origin.out.trim() !== "" ? origin.out.trim() : null,
    files,
  };
}
