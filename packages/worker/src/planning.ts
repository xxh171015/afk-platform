import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHOR, git, gitOrThrow } from "@afk/pipeline";
import type { PlanningCommitResult, PlanningTask } from "@afk/shared";
import type { PushFn } from "./push.ts";
import type { RepoStore } from "./repos.ts";
import { SETUP_COMMIT_MESSAGE, setupBase } from "./setup.ts";

export type { PlanningTask };

// The planning commit (GLOSSARY「Planning commit」, ADR 0005): the planning docs patch a person sent with
// `plat spec confirm`, merged three ways onto the planning repo's setup commit (ADR 0006; the default branch's head
// when there is no setup to merge) and pushed as the spec's integration branch there, so that the docs and the
// setup reach the default branch with the spec's pull request. Without a patch it is the setup commit, pushed as
// that branch, or the default branch's head and no branch is made. Built from refs in the bare clone, no checkout.
export async function runPlanningCommit(
  deps: {
    repos: Pick<RepoStore, "ensure" | "has" | "fetchBranch">;
    push: PushFn;
  },
  task: PlanningTask,
  log: (line: string) => void,
): Promise<PlanningCommitResult> {
  const { repo, integrationBranch: branch } = task;
  const dir = await deps.repos.ensure(repo.name, repo.url, repo.defaultBranch);
  const main = gitOrThrow(dir, [
    "rev-parse",
    `refs/heads/${repo.defaultBranch}`,
  ]);

  if (deps.repos.has(dir, `refs/heads/${branch}`)) {
    // A run whose push went through but whose answer was lost: the commit is there already.
    const head = gitOrThrow(dir, ["rev-parse", `refs/heads/${branch}`]);
    const message = gitOrThrow(dir, ["log", "-1", "--format=%B", head]);
    // the setup commit alone, when there was no patch or it added nothing to the setup
    const made = [SETUP_COMMIT_MESSAGE, ...(task.patch ? [task.message] : [])];
    if (made.some((m) => m.trim() === message)) {
      log(`${branch} already has the planning commit ${head}`);
      return { stage: "planning-commit", outcome: "committed", sha: head };
    }
    throw new Error(`${branch} already exists in ${repo.name}`);
  }

  const base = await setupBase(deps.repos, dir, repo, log);
  // The planning commit is the default branch's head: nothing to push, the integration branch is cut later.
  const unchanged = (why: string): PlanningCommitResult => {
    log(`${why}: the planning commit is ${repo.defaultBranch} at ${main}`);
    return { stage: "planning-commit", outcome: "unchanged", sha: main };
  };
  const publish = async (sha: string): Promise<PlanningCommitResult> => {
    const pushed = await deps.push({
      repoDir: dir,
      source: sha,
      target: `refs/heads/${branch}`,
      expectedOld: "",
    });
    if (!pushed.ok)
      throw new Error(`could not push ${branch}: ${pushed.error}`);
    gitOrThrow(dir, ["update-ref", `refs/heads/${branch}`, sha]);
    log(`planning commit ${sha} on ${branch}`);
    return { stage: "planning-commit", outcome: "committed", sha };
  };

  if (task.patch === null)
    return base === main
      ? unchanged("no planning docs and no setup to commit")
      : publish(base);

  const scratch = mkdtempSync(join(tmpdir(), "afk-planning-commit-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    gitOrThrow(dir, ["read-tree", base], env);
    const applied = git(
      dir,
      ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"],
      env,
      task.patch,
    );
    if (applied.code !== 0) {
      const unmerged = git(dir, ["ls-files", "-u", "-z"], env)
        .stdout.split("\0")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf("\t") + 1));
      const files = [...new Set(unmerged)].sort();
      if (files.length === 0) {
        throw new Error(
          `the planning docs patch does not apply: ${applied.out.slice(0, 400)}`,
        );
      }
      log(
        `the planning docs conflict with ${repo.defaultBranch}: ${files.join(", ")}`,
      );
      return { stage: "planning-commit", outcome: "conflict", files };
    }
    const tree = gitOrThrow(dir, ["write-tree"], env);
    if (tree === gitOrThrow(dir, ["rev-parse", `${base}^{tree}`])) {
      return base === main
        ? unchanged(`the planning docs are on ${repo.defaultBranch} already`)
        : await publish(base);
    }
    const commit = git(
      dir,
      ["commit-tree", tree, "-p", base, "-F", "-"],
      AUTHOR,
      `${task.message.trim()}\n`,
    );
    if (commit.code !== 0)
      throw new Error(`commit-tree failed: ${commit.out.slice(0, 400)}`);
    return await publish(commit.stdout.trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
