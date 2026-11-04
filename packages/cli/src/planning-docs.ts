import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  CONTEXT_DOC_PATHS,
  GLOSSARY_MAP_PATH,
  PLANNING_DOC_PATHS,
  SETUP_BRANCH,
  tryParseRepoUrl,
} from "@afk/shared";

// What `plat spec confirm` sends from the planning repo (ADR 0005): the planning docs as they are in the work tree,
// against where this checkout left the remote's default branch, as a patch the platform commits for the person.
// Reading them leaves the person's index, branch and files as they were; once the platform has them, confirm puts
// the copies not committed here aside (putPlanningDocsAside), so the checkout is back to HEAD for them.

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
  // `dir` is the checkout's top, `paths` the planning docs' paths in it
  | {
      status: "ok";
      patch: string;
      files: string[];
      dir: string;
      paths: string[];
    };

function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): { code: number; out: string; err: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
    input,
  });
  return {
    code: result.status ?? -1,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

// Paths from a glossary map are taken as they are, not as patterns.
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: "1" };

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

// The glossary map as the work tree, HEAD and the patch's base have it, those that do: a context added or removed
// since the base is a planning docs change too.
function readGlossaryMaps(dir: string, revisions: string[]): string[] {
  const file = join(dir, GLOSSARY_MAP_PATH);
  return [
    ...(existsSync(file) ? [readFileSync(file, "utf8")] : []),
    ...revisions
      .filter(Boolean)
      .map((rev) => git(dir, ["show", `${rev}:${GLOSSARY_MAP_PATH}`]))
      .filter((shown) => shown.code === 0)
      .map((shown) => shown.out),
  ];
}

// Where the contexts a glossary map links to live: the directories of the GLOSSARY.md files its Markdown links
// point at (`[Ordering](./src/ordering/GLOSSARY.md)`, also `<…>` and `#section` forms), inside the repo.
function contextsIn(map: string): string[] {
  const contexts: string[] = [];
  for (const [, angled, bare] of map.matchAll(
    /\]\(\s*(?:<([^>]+)>|([^)\s]+))/g,
  )) {
    const target = (angled ?? bare ?? "").replace(/[#?].*$/, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // a URL, not a path here
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {}
    const path = posix.normalize(decoded.replace(/^\/+/, ""));
    if (posix.basename(path) !== "GLOSSARY.md" || path.startsWith(".."))
      continue;
    const context = posix.dirname(path);
    if (context !== ".") contexts.push(context);
  }
  return contexts;
}

// The planning docs' paths in this checkout: in a multi-context repo also the glossary map and each context's
// glossary and ADRs.
function planningDocPaths(dir: string, revisions: string[]): string[] {
  const maps = readGlossaryMaps(dir, revisions);
  if (maps.length === 0) return PLANNING_DOC_PATHS;
  const contexts = [...new Set(maps.flatMap(contextsIn))];
  return [
    ...PLANNING_DOC_PATHS,
    GLOSSARY_MAP_PATH,
    ...contexts.flatMap((c) => CONTEXT_DOC_PATHS.map((path) => `${c}/${path}`)),
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

  const paths = planningDocPaths(dir, [head, base]);

  // A throwaway index, so that new files show up without touching the person's.
  const scratch = mkdtempSync(join(tmpdir(), "afk-planning-"));
  try {
    const env = {
      GIT_INDEX_FILE: join(scratch, "index"),
      ...LITERAL_PATHSPECS,
    };
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
      dir,
      paths,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The planning docs this checkout has and HEAD does not: changed, new or removed, staged or not.
export function uncommittedPlanningDocs(
  dir: string,
  paths: string[],
): string[] {
  const status = git(
    dir,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--",
      ...paths,
    ],
    LITERAL_PATHSPECS,
  ).out;
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

// Once the platform has the planning docs: the checkout's copies not committed go back to what HEAD has (a file
// HEAD does not have is removed, with the directories it leaves empty), without a stash. Commits, and every other
// path, stay as they are. Returns the paths put aside.
export function putPlanningDocsAside(dir: string, paths: string[]): string[] {
  const files = uncommittedPlanningDocs(dir, paths);
  const inHead = files.filter(
    (file) =>
      git(dir, ["cat-file", "-e", `HEAD:${file}`], LITERAL_PATHSPECS).code ===
      0,
  );
  const added = files.filter((file) => !inHead.includes(file));
  if (inHead.length > 0)
    git(
      dir,
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...inHead],
      LITERAL_PATHSPECS,
    );
  if (added.length > 0) {
    git(
      dir,
      ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...added],
      LITERAL_PATHSPECS,
    );
    for (const file of added) {
      rmSync(join(dir, file), { force: true });
      for (let parent = dirname(join(dir, file)); parent !== dir; ) {
        if (!existsSync(parent) || readdirSync(parent).length > 0) break;
        rmdirSync(parent);
        parent = dirname(parent);
      }
    }
  }
  return files;
}

const unmerged = (dir: string, paths: string[]): string[] =>
  git(
    dir,
    ["diff", "--name-only", "--diff-filter=U", "--", ...paths],
    LITERAL_PATHSPECS,
  )
    .out.split("\n")
    .filter(Boolean);

// A planning docs patch put back into the checkout, merged three ways with what is there; conflicts are marked in
// the files. The person's index is left as HEAD has it for these paths.
export function putPlanningDocsBack(
  dir: string,
  patch: string,
  paths: string[],
): { ok: true } | { ok: false; error: string } {
  const applied = git(
    dir,
    ["apply", "--3way", "--whitespace=nowarn", "-"],
    {},
    patch,
  );
  if (applied.code !== 0 && unmerged(dir, paths).length === 0)
    return { ok: false, error: applied.err.trim() };
  const files = uncommittedPlanningDocs(dir, paths);
  if (files.length > 0)
    git(dir, ["reset", "-q", "--", ...files], LITERAL_PATHSPECS);
  return { ok: true };
}

// The planning docs not ready to send: in the middle of a merge, or with conflict markers in them.
export function unresolvedPlanningDocs(dir: string, paths: string[]): string[] {
  const marked = uncommittedPlanningDocs(dir, paths).filter((file) => {
    const path = join(dir, file);
    return (
      existsSync(path) && /^(<{7}|>{7})( |$)/m.test(readFileSync(path, "utf8"))
    );
  });
  return [...new Set([...unmerged(dir, paths), ...marked])];
}
