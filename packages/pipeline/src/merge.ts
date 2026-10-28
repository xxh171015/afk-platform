import { git, gitOrThrow } from "./exec.ts";

export type MergeCandidate =
  | { conflict: false; candidate: string; tree: string }
  | { conflict: true; files: string[]; detail: string };

// The merge of the integration branch and a ticket branch as a commit that nothing points at yet, built from
// refs alone (no checkout, no working tree): `git merge-tree --write-tree` then `git commit-tree`. The
// candidate gate runs on it; only a passing candidate moves the integration branch.
export function mergeCandidate(
  repoDir: string,
  integrationRef: string,
  agentRef: string,
  message: string,
): MergeCandidate {
  const merged = git(repoDir, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    integrationRef,
    agentRef,
  ]);
  const [firstLine, ...rest] = merged.stdout.trim().split("\n");
  // Exit 1 means a conflict only when git still printed the (conflicted) tree; a ref that does not exist also
  // exits 1, with nothing on stdout.
  if (merged.code === 1 && /^[0-9a-f]{40,64}$/.test(firstLine ?? "")) {
    const files = rest;
    return { conflict: true, files, detail: merged.out.slice(0, 600) };
  }
  if (merged.code !== 0) {
    throw new Error(`git merge-tree failed: ${merged.out.slice(0, 400)}`);
  }
  const tree = merged.stdout.trim().split("\n")[0] as string;
  const candidate = gitOrThrow(repoDir, [
    "commit-tree",
    tree,
    "-p",
    gitOrThrow(repoDir, ["rev-parse", integrationRef]),
    "-p",
    gitOrThrow(repoDir, ["rev-parse", agentRef]),
    "-m",
    message,
  ]);
  return { conflict: false, candidate, tree };
}

// True when the agent branch is already part of the integration branch: a merge that was done before the
// worker lost its lease is treated as merged rather than done twice.
export function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
): boolean {
  return (
    git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]).code ===
    0
  );
}

export const hasRef = (repoDir: string, ref: string) =>
  git(repoDir, ["rev-parse", "--verify", "--quiet", ref]).code === 0;
