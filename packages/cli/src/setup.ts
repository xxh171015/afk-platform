import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { SETUP_BRANCH } from "@afk/shared";

// `plat setup`: the fixed steps of setting a project's repos up for the platform, which the afk-setup skill used to
// follow as prose. Each repo's setup is made in a temporary detached worktree outside the person's checkout, at
// <AFK home>/setup/<planning repo>/<repo>, from origin's afk/setup (or the default branch when there is none), and
// pushed to afk/setup (ADR 0006). Nothing here talks to the API; index.ts wires it to plat init and plat repo check.

const GATES = ".sandcastle/gates.yaml";
const AGENTS_MD = "AGENTS.md";
// What the agent that implements tickets reads; a repo with a CLAUDE.md and no AGENTS.md keeps it.
const AGENTS_FILES = [AGENTS_MD, "CLAUDE.md"];
// The section the agent that implements tickets needs to know nobody answers during a run.
const UNATTENDED = /^#+\s*(running unattended|无人值守)/im;

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    // never wait for a password or a host key
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

/** The folder that holds the setup worktrees of a project, named after its planning repo. */
export const setupsDir = (afkHome: string, planningRepo: string) =>
  join(afkHome, "setup", planningRepo);

const hasRef = (dir: string, ref: string) =>
  git(dir, ["rev-parse", "--verify", "--quiet", ref]).ok;
const hasFile = (dir: string, ref: string, path: string) =>
  git(dir, ["cat-file", "-e", `${ref}:${path}`]).ok;

// The commit-ish the setup starts from and checks against: origin's afk/setup, else the default branch.
const setupBase = (dir: string, defaultBranch: string) =>
  hasRef(dir, `origin/${SETUP_BRANCH}`)
    ? `origin/${SETUP_BRANCH}`
    : `origin/${defaultBranch}`;

/** What a repo's origin has of its setup: a repo with both files there, on the default branch or afk/setup, is set up. */
export function remoteSetup(
  dir: string,
  defaultBranch: string,
): { gates: boolean; agentsMd: boolean } {
  const refs = [`origin/${defaultBranch}`, `origin/${SETUP_BRANCH}`].filter(
    (ref) => hasRef(dir, ref),
  );
  return {
    gates: refs.some((ref) => hasFile(dir, ref, GATES)),
    agentsMd: refs.some((ref) =>
      AGENTS_FILES.some((file) => hasFile(dir, ref, file)),
    ),
  };
}

/** Whether origin's afk/setup no longer merges cleanly into the default branch (the platform then refuses it). */
export function setupConflicts(dir: string, defaultBranch: string): boolean {
  if (!hasRef(dir, `origin/${SETUP_BRANCH}`)) return false;
  return !git(dir, [
    "merge-tree",
    "--write-tree",
    `origin/${defaultBranch}`,
    `origin/${SETUP_BRANCH}`,
  ]).ok;
}

/** What a setup worktree lacks: the agent writes these before `plat setup --finish`. */
export interface Readiness {
  gates: boolean;
  agentsMd: "missing" | "present";
  runningUnattended: boolean; // AGENTS.md has the section
}

export function readinessIn(worktree: string): Readiness {
  const agents = AGENTS_FILES.map((file) => join(worktree, file)).find((file) =>
    existsSync(file),
  );
  return {
    gates: existsSync(join(worktree, GATES)),
    agentsMd: agents ? "present" : "missing",
    runningUnattended: agents
      ? UNATTENDED.test(readFileSync(agents, "utf8"))
      : false,
  };
}

/**
 * Whether a worktree holds work origin does not have: uncommitted changes, a merge in progress, or commits that are on
 * neither afk/setup nor the default branch. The merge of the default branch an earlier run made is not such work.
 */
export function hasOwnWork(worktree: string, defaultBranch: string): boolean {
  if (git(worktree, ["status", "--porcelain"]).out !== "") return true;
  if (hasRef(worktree, "MERGE_HEAD")) return true;
  return (
    git(worktree, [
      "log",
      "--oneline",
      "--no-merges",
      "HEAD",
      "--not",
      setupBase(worktree, defaultBranch),
      `origin/${defaultBranch}`,
    ]).out !== ""
  );
}

export interface PreparedWorktree {
  worktree: string;
  resumed: boolean; // an earlier run's worktree with work of its own, carried on
  problem?: string; // the merge of the default branch did not go through
}

/**
 * The repo's setup worktree at `worktree`, up to date with origin. An earlier run's worktree is carried on while it has
 * work of its own, else made again. When origin has afk/setup, the default branch is merged into it, so it still
 * merges into the default branch.
 */
export function prepareWorktree(
  checkout: string,
  worktree: string,
  defaultBranch: string,
): PreparedWorktree {
  let resumed = false;
  if (existsSync(worktree)) {
    if (hasOwnWork(worktree, defaultBranch)) resumed = true;
    else {
      git(checkout, ["worktree", "remove", "--force", worktree]);
      rmSync(worktree, { recursive: true, force: true });
      git(checkout, ["worktree", "prune"]);
    }
  }
  if (!resumed) {
    const made = git(checkout, [
      "worktree",
      "add",
      "--detach",
      worktree,
      setupBase(checkout, defaultBranch),
    ]);
    if (!made.ok)
      return {
        worktree,
        resumed,
        problem: `could not make the worktree: ${made.err}`,
      };
  }
  if (hasRef(checkout, `origin/${SETUP_BRANCH}`)) {
    const merged = git(worktree, [
      "merge",
      "--no-edit",
      `origin/${defaultBranch}`,
    ]);
    if (!merged.ok) {
      const conflicted =
        git(worktree, ["diff", "--name-only", "--diff-filter=U"]).out !== "";
      return {
        worktree,
        resumed,
        problem: conflicted
          ? `origin/${defaultBranch} does not merge into ${SETUP_BRANCH} cleanly; resolve the conflicts in ${worktree} and commit`
          : `could not merge origin/${defaultBranch} into ${SETUP_BRANCH} in ${worktree}: ${merged.err || merged.out}`,
      };
    }
  }
  return { worktree, resumed };
}

/**
 * An older afk-setup's leftovers: a `<checkout>-afk-setup` worktree and a local afk/setup branch. They go together when
 * the worktree has no uncommitted changes and the branch's commits are all on origin; otherwise both stay. The line
 * says which; undefined when there were none.
 */
export function removeLegacySetup(checkout: string): string | undefined {
  const old = `${checkout}-afk-setup`;
  const name = basename(old);
  const hasWorktree = existsSync(old);
  const hasBranch = hasRef(checkout, `refs/heads/${SETUP_BRANCH}`);
  if (!hasWorktree && !hasBranch) return undefined;
  if (hasWorktree && git(old, ["status", "--porcelain"]).out !== "")
    return `${name} kept: it has uncommitted changes`;
  const unpushed = (cwd: string, ref: string) =>
    git(cwd, ["log", "--oneline", ref, "--not", "--remotes"]).out !== "";
  if (hasWorktree && unpushed(old, "HEAD"))
    return `${name} kept: it has commits origin does not`;
  if (hasBranch && unpushed(checkout, SETUP_BRANCH))
    return `${name} kept: local ${SETUP_BRANCH} has commits origin does not`;
  // plain remove: it refuses a worktree with ignored or untracked files the check above cannot see
  if (hasWorktree && !git(checkout, ["worktree", "remove", old]).ok)
    return `${name} kept: git would not remove it (files git ignores are in it)`;
  if (hasBranch && !git(checkout, ["branch", "-D", SETUP_BRANCH]).ok)
    return `local ${SETUP_BRANCH} kept: git would not delete it`;
  git(checkout, ["worktree", "prune"]);
  return `removed what an older afk-setup left: ${[
    ...(hasWorktree ? [name] : []),
    ...(hasBranch ? [`local ${SETUP_BRANCH} branch`] : []),
  ].join(" and ")}`;
}

export interface SetupRepo {
  name: string;
  dir: string; // the person's checkout
  defaultBranch: string;
  planning: boolean;
}

/** One repo after `plat setup`: set up already (no worktree), or a worktree with what it lacks. */
export interface RepoSetupState {
  name: string;
  dir: string;
  planning: boolean;
  worktree: string | null; // null: origin has the setup, nothing to do here
  resumed: boolean;
  readiness: Readiness | null; // what the worktree has, when there is one
  leftover?: string; // what happened to an older afk-setup's leftovers
  problem?: string;
}

/**
 * Fetches the repo, clears an older afk-setup's leftovers, and makes its setup worktree when origin lacks the gate or
 * AGENTS.md, when afk/setup no longer merges into the default branch, or when an earlier run's worktree is still there
 * (its setup has not passed `plat setup --finish` yet).
 */
export function prepareRepo(repo: SetupRepo, setups: string): RepoSetupState {
  const state: RepoSetupState = {
    name: repo.name,
    dir: repo.dir,
    planning: repo.planning,
    worktree: null,
    resumed: false,
    readiness: null,
  };
  const fetched = git(repo.dir, ["fetch", "--quiet", "--prune", "origin"]);
  if (!fetched.ok) {
    state.problem = `could not fetch origin: ${fetched.err}`;
    return state;
  }
  state.leftover = removeLegacySetup(repo.dir);
  const worktree = join(setups, repo.name);
  const remote = remoteSetup(repo.dir, repo.defaultBranch);
  const needed =
    !remote.gates ||
    !remote.agentsMd ||
    setupConflicts(repo.dir, repo.defaultBranch) ||
    existsSync(worktree);
  if (!needed) return state;
  const prepared = prepareWorktree(repo.dir, worktree, repo.defaultBranch);
  state.worktree = prepared.worktree;
  state.resumed = prepared.resumed;
  state.problem = prepared.problem;
  if (existsSync(worktree)) state.readiness = readinessIn(worktree);
  return state;
}

/**
 * What a worktree lacks that plat can tell: the gate, AGENTS.md, or its "Running unattended" section. How to run the
 * tests, a single test file and the standards documents are for the agent to check in AGENTS.md.
 */
export function missingIn(readiness: Readiness | null): string[] {
  if (!readiness) return [];
  return [
    ...(readiness.gates ? [] : [GATES]),
    ...(readiness.agentsMd === "missing"
      ? [AGENTS_MD]
      : readiness.runningUnattended
        ? []
        : [`${AGENTS_MD}#Running unattended`]),
  ];
}

/** What one repo still needs, in a line: for the person and for the agent that writes the files. */
export function stateLine(state: RepoSetupState): string {
  const head = `${state.name}${state.planning ? " (planning repo)" : ""}`;
  if (state.problem) return `${head}: ${state.problem}`;
  if (!state.worktree || !state.readiness)
    return `${head}: set up on origin, nothing to do`;
  const needs = missingIn(state.readiness);
  return `${head}: ${state.resumed ? "carrying on in" : "worktree"} ${state.worktree}; ${
    needs.length > 0
      ? `write ${needs.join(", ")}`
      : "has the gate and AGENTS.md: check them, then plat setup --finish"
  }`;
}
