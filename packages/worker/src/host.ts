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
  if (task.kind === "spec-cleanup") return cleanUp(deps, task, log);
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

// Only what a spec makes is ever deleted: spec/<slug>, agent/T-<n> and agent/S-<n>-final. The API names the
// branches; this is the check that a wrong name there cannot reach a default or a release branch.
const SPEC_BRANCH =
  /^(spec\/[a-z0-9]+(-[a-z0-9]+)*|agent\/(T-[1-9][0-9]*|S-[1-9][0-9]*-final))$/;

// Closes the spec's open pull requests and deletes its branches. A step that fails does not stop the others (a
// branch that cannot be deleted must not keep a pull request open); the job then fails, is tried again, and
// everything already done is a no-op the second time.
async function cleanUp(
  deps: HostDeps,
  task: Extract<HostTask, { kind: "spec-cleanup" }>,
  log: (line: string) => void,
): Promise<Record<string, unknown>> {
  const repoRef = deps.repoRef ?? parseRepoUrl;
  const closed: number[] = [];
  const failures: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${what}: ${message}`);
      failures.push(`${what}: ${message}`);
    }
  };
  for (const pull of task.pulls)
    await attempt(`closing pull request ${pull.number}`, async () => {
      const after = await deps.adapter.closePullRequest({
        repo: repoRef(pull.repoUrl),
        number: pull.number,
      });
      log(`pull request ${pull.number} of ${pull.repoUrl} is ${after.state}`);
      if (after.state === "closed") closed.push(pull.id);
    });
  for (const { repoUrl, branch } of task.branches) {
    if (!SPEC_BRANCH.test(branch)) {
      log(`${branch} of ${repoUrl} is not a branch of a spec: left alone`);
      continue;
    }
    await attempt(`deleting ${branch}`, async () => {
      const outcome = await deps.adapter.deleteBranch({
        repo: repoRef(repoUrl),
        branch,
      });
      log(`${branch} of ${repoUrl}: ${outcome}`);
    });
  }
  if (failures.length > 0)
    throw new InfrastructureError(
      `spec cleanup could not do: ${failures.join("; ")}`.slice(0, 1000),
    );
  return { stage: "spec-cleanup", closed };
}
