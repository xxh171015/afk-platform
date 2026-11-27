import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "@afk/pipeline";

// The clone is writable from inside the sandbox, so its own .git/config is not to be trusted: no filesystem
// monitor, no hooks and no external diff or text conversion programs may run on the host because of it.
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export const slotSafeGit = (clone: string, args: string[]) =>
  git(clone, [...SAFE, ...args]);

// The slot clone and every worktree Sandcastle left inside it.
export function slotWorktreePlaces(clone: string): string[] {
  const places = [clone];
  const worktrees = join(clone, ".sandcastle", "worktrees");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees))
      places.push(join(worktrees, name));
  }
  return places;
}

export function slotWorktreesClean(clone: string): boolean {
  return slotWorktreePlaces(clone).every((place) => {
    const status = slotSafeGit(place, ["status", "--porcelain"]);
    return status.code === 0 && status.stdout.trim() === "";
  });
}

export type BranchCommit = { sha: string; subject: string };

function refExists(repoDir: string, ref: string): boolean {
  return (
    git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).code === 0 ||
    git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`])
      .code === 0
  );
}

export function commitsOnBranch(
  repoDir: string,
  ref: string,
  since?: string,
): BranchCommit[] {
  if (!refExists(repoDir, ref)) return [];
  const range = since ? `${since}..${ref}` : ref;
  return git(repoDir, ["log", "--format=%H\t%s", "--reverse", range])
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return {
        sha: line.slice(0, tab < 0 ? line.length : tab),
        subject: tab < 0 ? "" : line.slice(tab + 1),
      };
    });
}
