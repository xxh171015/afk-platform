import { spawnSync } from "node:child_process";

// What `plat spec confirm` inspects in the caller's git workspace (issue #139, ADR 0003).
// The API only stores the SHA; these checks never run on page confirm.

export interface RegisteredRepo {
  name: string;
  url: string;
  defaultBranch: string;
}

export type PlanningInspect =
  | { status: "skip" }
  | {
      status: "ok";
      sha: string;
      repoName: string;
      dirty: boolean;
    }
  | {
      status: "reject";
      reason: "not-pushed" | "not-descendant" | "dirty";
      message: string;
      sha: string;
      repoName: string;
      dirty: boolean;
    };

const DOC_PATHS = ["GLOSSARY.md", "AGENTS.md", "docs/adr"];

export function inspectPlanningCommit(
  cwd: string,
  repos: RegisteredRepo[],
): PlanningInspect {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return { status: "skip" };
  const origin = git(root.stdout, ["remote", "get-url", "origin"]);
  if (origin.code !== 0) return { status: "skip" };
  const repo = repos.find((r) => sameRemote(origin.stdout, r.url));
  if (!repo) return { status: "skip" };
  const sha = git(root.stdout, ["rev-parse", "HEAD"]);
  if (sha.code !== 0 || !/^[0-9a-f]{40}$/.test(sha.stdout)) {
    return { status: "skip" };
  }
  const dirty =
    git(root.stdout, ["status", "--porcelain", "--", ...DOC_PATHS]).stdout
      .length > 0;
  const facts = { sha: sha.stdout, repoName: repo.name, dirty };
  const remotes = git(root.stdout, ["branch", "-r", "--contains", "HEAD"]);
  if (remotes.code !== 0 || remotes.stdout.length === 0) {
    return {
      status: "reject",
      reason: "not-pushed",
      message:
        "HEAD is not on any remote-tracking branch; push the planning commit first",
      ...facts,
    };
  }
  const defaultRef = remoteOrLocal(root.stdout, repo.defaultBranch);
  if (
    git(root.stdout, ["merge-base", "--is-ancestor", defaultRef, "HEAD"])
      .code !== 0
  ) {
    return {
      status: "reject",
      reason: "not-descendant",
      message: `HEAD is not a descendant of ${repo.defaultBranch}`,
      ...facts,
    };
  }
  if (dirty) {
    return {
      status: "reject",
      reason: "dirty",
      message:
        "GLOSSARY.md, docs/adr or AGENTS.md have changes that are not in HEAD; commit them or pass --force",
      ...facts,
    };
  }
  return { status: "ok", ...facts };
}

function remoteOrLocal(cwd: string, branch: string): string {
  const remote = `refs/remotes/origin/${branch}`;
  return git(cwd, ["rev-parse", "--verify", "--quiet", remote]).code === 0
    ? remote
    : branch;
}

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return {
    code: result.status ?? -1,
    stdout: (result.stdout ?? "").trim(),
  };
}

export function sameRemote(a: string, b: string): boolean {
  if (strip(a) === strip(b)) return true;
  const left = parseRepo(a);
  const right = parseRepo(b);
  return (
    left !== null &&
    right !== null &&
    left.owner === right.owner &&
    left.name === right.name
  );
}

function strip(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

// Same shapes as packages/host parseRepoUrl: https, ssh://, git@host:owner/name.
function parseRepo(url: string): { owner: string; name: string } | null {
  const match =
    /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
}
