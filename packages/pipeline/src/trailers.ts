import { git, gitOut } from "./exec.ts";

// Traceability trailers on every commit of a ticket's branch (docs/design.md「Git 操作规范」): Spec, Ticket, Run.
// Cursor's own Co-authored-by trailer stays; only our three count for tracing.

export interface TrailerIds {
  spec: string; // S-12
  ticket: string; // T-123
  run: string; // R-456
}

const ID = {
  spec: /^S-[1-9][0-9]*$/,
  ticket: /^T-[1-9][0-9]*$/,
  run: /^R-[1-9][0-9]*$/,
};

export interface StampResult {
  rewritten: number;
  error?: string;
}

// Adds the trailers to the commits in `before..branch`. The agent's worktree is gone by now, so the rewrite
// happens in a temporary one (`tmpDir`), which is removed again whatever the outcome.
export function stampTrailers(
  repoDir: string,
  branch: string,
  before: string,
  ids: TrailerIds,
  tmpDir: string,
): StampResult {
  // The ids go into a shell command run by rebase --exec: only our own id formats may pass.
  for (const key of ["spec", "ticket", "run"] as const) {
    if (!ID[key].test(ids[key])) {
      throw new RangeError(`not a ${key} id: ${JSON.stringify(ids[key])}`);
    }
  }
  const range = `${before}..${branch}`;
  const count = Number(gitOut(repoDir, ["rev-list", "--count", range]));
  if (count === 0) return { rewritten: 0 };

  const add = git(repoDir, ["worktree", "add", tmpDir, branch]);
  if (add.code !== 0) {
    return {
      rewritten: 0,
      error: `worktree add failed: ${add.out.slice(0, 400)}`,
    };
  }
  try {
    // addIfDifferent: stamping a branch that already carries the trailers (a rerun) adds nothing.
    const amend = `git -c trailer.ifexists=addIfDifferent commit --amend --no-edit --trailer 'Spec: ${ids.spec}' --trailer 'Ticket: ${ids.ticket}' --trailer 'Run: ${ids.run}'`;
    const rebase = git(tmpDir, [
      "rebase",
      "--rebase-merges",
      "--exec",
      amend,
      before,
    ]);
    if (rebase.code !== 0) {
      git(tmpDir, ["rebase", "--abort"]);
      return {
        rewritten: 0,
        error: `rebase failed: ${rebase.out.slice(0, 400)}`,
      };
    }
    return { rewritten: count };
  } finally {
    git(repoDir, ["worktree", "remove", "--force", tmpDir]);
  }
}
