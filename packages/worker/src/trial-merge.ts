import { gitOrThrow, trialMerge } from "@afk/pipeline";
import type { TrialMergeTask } from "@afk/shared";
import type { RepoStore } from "./repos.ts";

export type { TrialMergeTask };

// Trial-merge: merge-tree this spec's integration branch against the other specs in the same repo that
// still have a branch. Conflicts are reported; a missing peer branch is skipped so one gone spec does
// not fail the job.

export type TrialMergeResult = {
  stage: "trial-merge";
  peers: {
    specId: number;
    files: string[];
    ourSha: string;
    theirSha: string;
  }[];
};

export function runTrialMerge(
  deps: { repos: Pick<RepoStore, "ensure" | "has"> },
  task: TrialMergeTask,
  log: (line: string) => void,
): TrialMergeResult {
  const dir = deps.repos.ensure(
    task.repo.name,
    task.repo.url,
    task.repo.defaultBranch,
  );
  const ourRef = `refs/heads/${task.ours.branch}`;
  const ourSha = gitOrThrow(dir, ["rev-parse", ourRef]);
  const peers: TrialMergeResult["peers"] = [];
  for (const peer of task.peers) {
    const theirRef = `refs/heads/${peer.branch}`;
    if (!deps.repos.has(dir, theirRef)) {
      log(`trial-merge: ${peer.branch} is not in the clone`);
      continue;
    }
    try {
      const theirSha = gitOrThrow(dir, ["rev-parse", theirRef]);
      const { files } = trialMerge(dir, task.ours.branch, peer.branch);
      peers.push({ specId: peer.specId, files, ourSha, theirSha });
    } catch (error) {
      log(
        `trial-merge: ${peer.branch} failed (${error instanceof Error ? error.message : error})`,
      );
    }
  }
  return { stage: "trial-merge", peers };
}
