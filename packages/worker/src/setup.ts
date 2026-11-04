import { AUTHOR, git, gitOrThrow } from "@afk/pipeline";
import { SETUP_BRANCH } from "@afk/shared";
import type { RepoStore } from "./repos.ts";

export const SETUP_COMMIT_MESSAGE = `Set up for the AFK platform (${SETUP_BRANCH})`;

// The setup commit (GLOSSARY「Setup commit」, ADR 0006): a repo's afk/setup branch, merged onto the head of its
// default branch, is where a spec's integration branch starts, so that the setup reaches the default branch with
// the spec's pull request and the worker gates and reads it before then. When origin has no afk/setup, or the
// default branch has its changes already, the head of the default branch is the start.
export function setupBase(
  repos: Pick<RepoStore, "fetchBranch">,
  dir: string,
  repo: { name: string; url: string; defaultBranch: string },
  log: (line: string) => void,
): string {
  const main = gitOrThrow(dir, [
    "rev-parse",
    `refs/heads/${repo.defaultBranch}`,
  ]);
  if (!repos.fetchBranch(dir, repo.url, SETUP_BRANCH)) return main;
  const setup = gitOrThrow(dir, ["rev-parse", `refs/heads/${SETUP_BRANCH}`]);

  const merged = git(dir, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    main,
    setup,
  ]);
  const [tree, ...rest] = merged.stdout.trim().split("\n");
  if (merged.code === 1) {
    const files = [...new Set(rest.filter(Boolean))].sort();
    throw new Error(
      `${SETUP_BRANCH} in ${repo.name} no longer merges into ${repo.defaultBranch} (${files.join(", ")}): run the afk-setup skill again, it merges ${repo.defaultBranch} into ${SETUP_BRANCH}`,
    );
  }
  if (merged.code !== 0 || !tree)
    throw new Error(`merge-tree failed: ${merged.out.slice(0, 400)}`);
  if (tree === gitOrThrow(dir, ["rev-parse", `${main}^{tree}`])) return main;

  const commit = git(
    dir,
    ["commit-tree", tree, "-p", main, "-p", setup, "-F", "-"],
    AUTHOR,
    `${SETUP_COMMIT_MESSAGE}\n`,
  );
  if (commit.code !== 0)
    throw new Error(`commit-tree failed: ${commit.out.slice(0, 400)}`);
  const sha = commit.stdout.trim();
  log(`setup commit ${sha}: ${SETUP_BRANCH} merged onto ${repo.defaultBranch}`);
  return sha;
}
