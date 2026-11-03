import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANNING_DOC_PATHS, tryParseRepoUrl } from "@afk/shared";

// What `plat spec confirm` sends from the planning repo (ADR 0005): the planning docs as they are in the work tree,
// against where this checkout left the remote's default branch, as a patch the platform commits for the person.
// It reads git only: the person's index, branch and files stay as they were.

export interface RegisteredRepo {
  name: string;
  url: string;
  defaultBranch: string;
}

export type PlanningDocs =
  // not in a checkout of one of the project's repos: confirm sends nothing, like the page. `checkout` is the git
  // checkout it is in, when it is in one: a repo the project may be missing.
  | { status: "elsewhere"; checkout?: string }
  // in a checkout of another repo of the project
  | { status: "other-repo"; repo: string }
  | { status: "ok"; patch: string; files: string[] };

function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? -1, out: result.stdout ?? "" };
}

const sameRepo = (a: string, b: string) => {
  const left = tryParseRepoUrl(a);
  const right = tryParseRepoUrl(b);
  return left && right
    ? left.owner === right.owner && left.name === right.name
    : a.trim() === b.trim();
};

export function readPlanningDocs(
  cwd: string,
  repos: RegisteredRepo[],
  planningRepo: string,
): PlanningDocs {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { status: "elsewhere" };
  const dir = top.out.trim();
  const origin = git(dir, ["config", "--get", "remote.origin.url"]).out.trim();
  const repo = origin ? repos.find((r) => sameRepo(r.url, origin)) : undefined;
  if (!repo) return { status: "elsewhere", checkout: dir };
  if (repo.name !== planningRepo)
    return { status: "other-repo", repo: repo.name };

  // The base is where this checkout and the remote's default branch part: the patch carries the commits made
  // here and not pushed as well as the files not committed, and nothing someone else put on the default branch.
  const remote = `refs/remotes/origin/${repo.defaultBranch}`;
  const head = git(dir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]).out.trim();
  const fork = git(dir, ["merge-base", "HEAD", remote]);
  const base = fork.code === 0 ? fork.out.trim() : head;

  // A throwaway index, so that new files show up without touching the person's.
  const scratch = mkdtempSync(join(tmpdir(), "afk-planning-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(dir, ["read-tree", head || "--empty"], env);
    const tracked = git(
      dir,
      ["ls-files", "-z", "--", ...PLANNING_DOC_PATHS],
      env,
    )
      .out.split("\0")
      .filter(Boolean);
    const present = PLANNING_DOC_PATHS.filter(
      (path) =>
        existsSync(join(dir, path)) ||
        tracked.some((file) => file === path || file.startsWith(`${path}/`)),
    );
    if (present.length > 0) git(dir, ["add", "-A", "--", ...present], env);
    const diff = (extra: string[]) =>
      git(
        dir,
        ["diff", "--cached", ...extra, base, "--", ...PLANNING_DOC_PATHS],
        env,
      ).out;
    return {
      status: "ok",
      patch: diff(["--binary", "--full-index"]),
      files: diff(["--name-only"]).split("\n").filter(Boolean),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
