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
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  CONTEXT_DOC_PATHS,
  GLOSSARY_MAP_PATH,
  PLANNING_DOC_PATHS,
  sameRepoUrl,
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

// The project's repo this checkout is, when origin matches a registered URL (https/ssh/.git spellings included).
export function matchProjectRepo(
  cwd: string,
  repos: RegisteredRepo[],
): RegisteredRepo | undefined {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return undefined;
  const origin = git(top.out.trim(), [
    "config",
    "--get",
    "remote.origin.url",
  ]).out.trim();
  return origin ? repos.find((r) => sameRepoUrl(r.url, origin)) : undefined;
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

// Machine-only planning files: never listed, never sent (ADR 0013). Tracker docs live under docs/agents/.
export function isMachineOnlyPlanningPath(path: string): boolean {
  return (
    path === "CLAUDE.local.md" ||
    path === ".cursor/rules/afk-platform.mdc" ||
    path === "docs/agents" ||
    path.startsWith("docs/agents/")
  );
}

export interface PlanningChange {
  status: string;
  path: string;
}

function gitHead(dir: string): string {
  return git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).out.trim();
}

export function planningMergeBase(dir: string, defaultBranch: string): string {
  const remote = `refs/remotes/origin/${defaultBranch}`;
  const head = gitHead(dir);
  const merged = git(dir, ["merge-base", "HEAD", remote]);
  return (merged.code === 0 ? merged.out.trim() : head) || head;
}

// Isolated index: HEAD's tree, then the caller stages and diffs. The person's index is left alone.
function withScratchIndex<T>(
  dir: string,
  extraEnv: Record<string, string>,
  run: (env: Record<string, string>) => T,
): T {
  const head = gitHead(dir);
  const scratch = mkdtempSync(join(tmpdir(), "afk-planning-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index"), ...extraEnv };
    git(dir, ["read-tree", head || "--empty"], env);
    return run(env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Local changes against the patch base: uncommitted (staged and not), new unignored files, files in unpushed
// commits, and deletions. Ignored files stay out (`git add -A` honours gitignore and info/exclude).
export function listPlanningChanges(
  dir: string,
  defaultBranch: string,
): PlanningChange[] {
  const base = planningMergeBase(dir, defaultBranch);
  if (!base) return [];
  return withScratchIndex(dir, {}, (env) => {
    git(dir, ["add", "-A"], env);
    const parts = git(
      dir,
      ["diff", "--cached", "-z", "--name-status", "--no-renames", base],
      env,
    )
      .out.split("\0")
      .filter(Boolean);
    const changes: PlanningChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] ?? "";
      const path = parts[i + 1] ?? "";
      if (!path || isMachineOnlyPlanningPath(path)) continue;
      changes.push({ status, path });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  });
}

function repoRelativePath(repoDir: string, cwd: string, raw: string): string {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const rel = relative(repoDir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return raw.replaceAll("\\", "/").replace(/\/+$/, "");
  }
  return rel.split(sep).join("/").replace(/\/+$/, "") || ".";
}

function selectorCovers(selector: string, file: string): boolean {
  if (selector === ".") return true;
  return file === selector || file.startsWith(`${selector}/`);
}

export type PlanningSelectionOptions = {
  send: string[];
  keepLocal: string[];
  sendAll: boolean;
  keepLocalAll: boolean;
};

export type PlanningSelection =
  | { ok: true; send: string[]; keepLocal: string[] }
  | { ok: false; kind: "unknown-path"; path: string }
  | { ok: false; kind: "both"; path: string }
  | { ok: false; kind: "uncovered"; changes: PlanningChange[] };

export function selectPlanningChanges(
  changes: PlanningChange[],
  options: PlanningSelectionOptions,
  repoDir: string,
  cwd: string,
): PlanningSelection {
  const listed = changes.map((change) => change.path);
  const sendSelectors = options.send.map((path) =>
    repoRelativePath(repoDir, cwd, path),
  );
  const keepSelectors = options.keepLocal.map((path) =>
    repoRelativePath(repoDir, cwd, path),
  );
  for (const [raw, selector] of options.send.map(
    (path, i) => [path, sendSelectors[i] ?? path] as const,
  )) {
    if (!listed.some((file) => selectorCovers(selector, file)))
      return { ok: false, kind: "unknown-path", path: raw };
  }
  for (const [raw, selector] of options.keepLocal.map(
    (path, i) => [path, keepSelectors[i] ?? path] as const,
  )) {
    if (!listed.some((file) => selectorCovers(selector, file)))
      return { ok: false, kind: "unknown-path", path: raw };
  }

  const send: string[] = [];
  const keepLocal: string[] = [];
  const uncovered: PlanningChange[] = [];
  for (const change of changes) {
    const inSend = sendSelectors.some((selector) =>
      selectorCovers(selector, change.path),
    );
    const inKeep = keepSelectors.some((selector) =>
      selectorCovers(selector, change.path),
    );
    if (inSend && inKeep) return { ok: false, kind: "both", path: change.path };
    if (inSend) {
      send.push(change.path);
      continue;
    }
    if (inKeep) {
      keepLocal.push(change.path);
      continue;
    }
    if (options.sendAll && options.keepLocalAll)
      return { ok: false, kind: "both", path: change.path };
    if (options.sendAll) send.push(change.path);
    else if (options.keepLocalAll) keepLocal.push(change.path);
    else uncovered.push(change);
  }
  if (uncovered.length > 0)
    return { ok: false, kind: "uncovered", changes: uncovered };
  return { ok: true, send, keepLocal };
}

export function pathsInPlanningPatch(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = match[2] ?? match[1];
    if (path) files.push(path);
  }
  return [...new Set(files)];
}

export function isSecretPlanningPath(path: string): boolean {
  const name = posix.basename(path);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.startsWith("id_rsa")
  );
}

// Selected files against the patch base (`--binary --full-index`), same algorithm as before, any paths.
export function buildPlanningPatch(
  dir: string,
  defaultBranch: string,
  paths: string[],
): { patch: string; files: string[] } {
  if (paths.length === 0) return { patch: "", files: [] };
  const base = planningMergeBase(dir, defaultBranch);
  return withScratchIndex(dir, LITERAL_PATHSPECS, (env) => {
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
      patch: diff(["--binary", "--full-index"]),
      files: diff(["--name-only"]).split("\n").filter(Boolean),
    };
  });
}

// Confirm no longer uses this for the patch; import records listPlanningChanges instead.
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
  const repo = origin
    ? repos.find((r) => sameRepoUrl(r.url, origin))
    : undefined;
  if (!repo) return { status: "elsewhere", checkout: dir };
  if (repo.name !== planningRepo)
    return { status: "other-repo", repo: repo.name };

  // Locate the checkout and the old path table (conflict fallback). Confirm and import list
  // local changes separately and build the patch from the files the person selected.
  const head = gitHead(dir);
  const base = planningMergeBase(dir, repo.defaultBranch);
  const paths = planningDocPaths(dir, [head, base]);
  return { status: "ok", patch: "", files: [], dir, paths };
}

// The planning docs this checkout has and HEAD does not: changed, new or removed, staged or not.
export function uncommittedPlanningDocs(
  dir: string,
  paths: string[],
): string[] {
  if (paths.length === 0) return [];
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
  if (paths.length === 0) return [];
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
