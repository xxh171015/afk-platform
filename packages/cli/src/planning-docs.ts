import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PLANNING_DOC_PATHS, SETUP_BRANCH, tryParseRepoUrl } from "@afk/shared";

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

// Planning in the afk/setup worktree (ADR 0006): the platform commits the patch onto the setup commit, which has
// afk/setup in it, so the patch is taken against afk/setup as the remote has it and carries the planning docs only,
// not the setup's own AGENTS.md. Only while this checkout has afk/setup and the default branch does not.
function setupTip(dir: string, fork: string | undefined): string | undefined {
  const remote = `refs/remotes/origin/${SETUP_BRANCH}`;
  const tip = git(dir, ["rev-parse", "--verify", "--quiet", remote]);
  if (tip.code !== 0) return undefined;
  const within = (ref: string) =>
    git(dir, ["merge-base", "--is-ancestor", remote, ref]).code === 0;
  if (!within("HEAD") || (fork && within(fork))) return undefined;
  return tip.out.trim();
}

const GLOSSARY_MAP = "GLOSSARY-MAP.md";

// The planning docs' paths in this checkout: in a multi-context repo (GLOSSARY「Planning docs」) also the map and,
// for each context it links to, that context's GLOSSARY.md and docs/adr. The map is read as it is in the work
// tree, or as HEAD has it when the person removed it. Links that leave the repo are left out.
function planningDocPaths(dir: string, head: string): string[] {
  const file = join(dir, GLOSSARY_MAP);
  const map = existsSync(file)
    ? readFileSync(file, "utf8")
    : head
      ? git(dir, ["show", `${head}:${GLOSSARY_MAP}`]).out
      : "";
  if (!map) return PLANNING_DOC_PATHS;
  const contexts = new Set<string>();
  for (const [, target] of map.matchAll(/\]\(\s*<?([^)\s>#]+)/g)) {
    const path = posix.normalize(target.replace(/^\/+/, ""));
    if (posix.basename(path) !== "GLOSSARY.md" || path.startsWith(".."))
      continue;
    const context = posix.dirname(path);
    if (context !== ".") contexts.add(context);
  }
  return [
    ...PLANNING_DOC_PATHS,
    GLOSSARY_MAP,
    ...[...contexts].flatMap((c) => [`${c}/GLOSSARY.md`, `${c}/docs/adr`]),
  ];
}

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
  const merged = git(dir, ["merge-base", "HEAD", remote]);
  const fork = merged.code === 0 ? merged.out.trim() : undefined;
  const base = setupTip(dir, fork) ?? fork ?? head;

  const paths = planningDocPaths(dir, head);

  // A throwaway index, so that new files show up without touching the person's.
  const scratch = mkdtempSync(join(tmpdir(), "afk-planning-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(dir, ["read-tree", head || "--empty"], env);
    const tracked = git(dir, ["ls-files", "-z", "--", ...paths], env)
      .out.split("\0")
      .filter(Boolean);
    const present = paths.filter(
      (path) =>
        existsSync(join(dir, path)) ||
        tracked.some((file) => file === path || file.startsWith(`${path}/`)),
    );
    if (present.length > 0) git(dir, ["add", "-A", "--", ...present], env);
    const diff = (extra: string[]) =>
      git(dir, ["diff", "--cached", ...extra, base, "--", ...paths], env).out;
    return {
      status: "ok",
      patch: diff(["--binary", "--full-index"]),
      files: diff(["--name-only"]).split("\n").filter(Boolean),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
