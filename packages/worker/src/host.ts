import {
  type AppAccess,
  type GitLabAccess,
  type HostAdapter,
  HostError,
  parseRepoUrl,
  type RepoRef,
} from "@afk/host";
import {
  fitPrDescription,
  type HostTask,
  isPlatformBranch,
  splicePackSection,
} from "@afk/shared";
import { InfrastructureError } from "./executor.ts";

// The jobs that talk to the code host. The worker does them because the host's credentials are only here.
export interface HostDeps {
  adapter: HostAdapter;
  repoRef?: (url: string) => RepoRef;
  // whether the GitHub App or GitLab PAT can work on a repo; absent where this worker has no credentials to check
  checkAccess?: (repo: RepoRef) => Promise<AppAccess | GitLabAccess>;
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
  if (task.kind === "patch-pr-body") {
    try {
      const current = await deps.adapter.getPullRequestBody({
        repo: repoRef(task.repoUrl),
        number: task.number,
      });
      const full = splicePackSection(current, task.section);
      const summarized = splicePackSection(current, task.summary);
      const body = fitPrDescription(full, summarized, task.summary);
      await deps.adapter.updatePullRequestBody({
        repo: repoRef(task.repoUrl),
        number: task.number,
        body,
      });
      log(`updated description of pull request ${task.number}`);
      return { stage: "patch-pr-body", outcome: "patched" };
    } catch (error) {
      throw new InfrastructureError(
        error instanceof HostError || error instanceof RangeError
          ? error.message
          : `could not update the pull request description: ${String(error)}`,
      );
    }
  }
  if (task.kind === "pr-ready") {
    try {
      const info = await deps.adapter.markReady({
        repo: repoRef(task.pull.repoUrl),
        number: task.pull.number,
      });
      log(
        `pull request ${task.pull.number} of ${task.pull.repoUrl} is ${info.draft ? "still a draft" : "ready"}`,
      );
      return { stage: "pr-ready", ...info };
    } catch (error) {
      // the job fails and is tried again a minute later (and, after three failures, a person looks at it)
      throw new InfrastructureError(
        error instanceof HostError || error instanceof RangeError
          ? error.message
          : `could not mark the pull request ready: ${String(error)}`,
      );
    }
  }
  if (task.kind === "repo-access") {
    if (!deps.checkAccess)
      throw new InfrastructureError("this worker cannot check repo access");
    try {
      const access = await deps.checkAccess(repoRef(task.repoUrl));
      log(`access on ${task.repoUrl}: ${access.state}`);
      return { stage: "repo-access", ...access };
    } catch (error) {
      throw new InfrastructureError(
        error instanceof HostError || error instanceof RangeError
          ? error.message
          : `could not check repo access: ${String(error)}`,
      );
    }
  }
  if (task.kind === "spec-cleanup") return cleanUp(deps, task, log);
  const pulls = [];
  for (const pull of task.pulls ?? []) {
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
        mergedBy: info.mergedBy,
        mergedAt: info.mergedAt,
        mergedByPlatform: info.mergedByPlatform,
      });
    } catch (error) {
      if (error instanceof HostError && error.status === 429)
        throw new InfrastructureError(error.message);
      // one pull request that cannot be read must not hide what the others look like
      const message = error instanceof Error ? error.message : String(error);
      log(`pull request ${pull.number} of ${pull.repoUrl}: ${message}`);
      pulls.push({ id: pull.id, error: message.slice(0, 400) });
    }
  }
  const defaults = [];
  for (const branch of task.defaults ?? []) {
    try {
      const sha = await deps.adapter.getBranchSha({
        repo: repoRef(branch.repoUrl),
        branch: branch.branch,
      });
      defaults.push({ repoUrl: branch.repoUrl, sha });
    } catch (error) {
      if (error instanceof HostError && error.status === 429)
        throw new InfrastructureError(error.message);
      const message = error instanceof Error ? error.message : String(error);
      log(`default branch ${branch.branch} of ${branch.repoUrl}: ${message}`);
    }
  }
  return { stage: "host-sync", pulls, defaults };
}

// Closes the spec's open pull requests and deletes its branches. Only what a spec makes is ever deleted
// (isPlatformBranch: spec/<slug>, agent/T-<n>, agent/S-<n>-final, agent/S-<n>-update, each with or without the database's id after
// the first slash): the API names the branches, and this is the check that a wrong name there cannot reach a
// default or a release branch. A step that fails does not stop the others (a
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
    if (!isPlatformBranch(branch)) {
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
