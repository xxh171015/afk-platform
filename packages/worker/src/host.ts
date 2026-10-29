import {
  type HostAdapter,
  HostError,
  parseRepoUrl,
  type RepoRef,
} from "@afk/host";
import type { HostTask } from "@afk/shared";
import { InfrastructureError } from "./executor.ts";

// The jobs that talk to the code host. The worker does them because the host's credentials are only here.
export interface HostDeps {
  adapter: HostAdapter;
  repoRef?: (url: string) => RepoRef;
}

export const HOST_JOB_TYPES: readonly string[] = ["open-pr", "host-sync"];
export const HOST_CAPABILITY = "host";

export async function runHostTask(
  deps: HostDeps,
  task: HostTask,
  log: (line: string) => void,
): Promise<Record<string, unknown>> {
  const repoRef = deps.repoRef ?? parseRepoUrl;
  if (task.kind === "open-pr") {
    let pr: Awaited<ReturnType<HostAdapter["openPullRequest"]>>;
    try {
      pr = await deps.adapter.openPullRequest({
        repo: repoRef(task.repoUrl),
        head: task.head,
        base: task.base,
        title: task.title,
        body: task.body,
        draft: task.draft,
      });
    } catch (error) {
      // the job fails and is tried again (and, after three failures, a person looks at it)
      throw new InfrastructureError(
        error instanceof HostError || error instanceof RangeError
          ? error.message
          : `could not open the pull request: ${String(error)}`,
      );
    }
    log(`opened ${pr.url} (${pr.state})`);
    return { stage: "open-pr", outcome: "opened", ...pr };
  }
  const pulls = [];
  for (const pull of task.pulls) {
    try {
      const info = await deps.adapter.getPullRequest({
        repo: repoRef(pull.repoUrl),
        number: pull.number,
      });
      pulls.push({
        id: pull.id,
        state: info.state,
        draft: info.draft,
        headSha: info.headSha,
        ci: info.ci,
        review: info.review,
      });
    } catch (error) {
      // one pull request that cannot be read must not hide what the others look like
      const message = error instanceof Error ? error.message : String(error);
      log(`pull request ${pull.number} of ${pull.repoUrl}: ${message}`);
      pulls.push({ id: pull.id, error: message.slice(0, 400) });
    }
  }
  return { stage: "host-sync", pulls };
}
