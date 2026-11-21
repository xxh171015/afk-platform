import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { repoHtmlUrl, tryParseRepoUrl } from "@afk/shared";

// What `plat spec create --ref` / `plat spec edit --ref` turn a directory, clone address, or project repo name
// into before POST /specs or PUT /specs/{id}/refs. Git is the source of origin URL and default branch.

export class SpecRefError extends Error {}

export interface SpecRefInput {
  url: string;
  defaultBranch: string;
}

export interface ResolvedSpecRef extends SpecRefInput {
  // Local HEAD is not origin's default-branch tip (unpushed commits or another branch).
  originAheadWarning?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function looksLikeAddress(value: string): boolean {
  if (tryParseRepoUrl(value)) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return true;
  return value.startsWith("git@");
}

function canonicalUrl(raw: string): string {
  const html = repoHtmlUrl(raw);
  return html ? `${html}.git` : raw;
}

function originUrlOf(dir: string): string {
  const origin = git(dir, ["remote", "get-url", "origin"]);
  if (!origin.ok || origin.out === "") {
    throw new SpecRefError(`${dir}: has no origin remote`);
  }
  return origin.out;
}

function originDefaultBranchOf(dir: string): string {
  const symbolic = git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const fromSymbolic = /^refs\/remotes\/origin\/(\S+)$/.exec(symbolic.out)?.[1];
  if (symbolic.ok && fromSymbolic) return fromSymbolic;
  const remote = git(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
  const fromRemote = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.out)?.[1];
  if (remote.ok && fromRemote) return fromRemote;
  return "main";
}

function originAheadWarning(
  dir: string,
  defaultBranch: string,
): string | undefined {
  const head = git(dir, ["rev-parse", "HEAD"]);
  const origin = git(dir, [
    "rev-parse",
    `refs/remotes/origin/${defaultBranch}`,
  ]);
  if (!head.ok || !origin.ok) return undefined;
  if (head.out === origin.out) return undefined;
  return `HEAD is not origin/${defaultBranch} (unpushed local commits); the agent will see origin, not this checkout`;
}

function fromDirectory(dir: string): ResolvedSpecRef {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new SpecRefError(`${dir}: not a git checkout`);
  const checkout = top.out;
  const defaultBranch = originDefaultBranchOf(checkout);
  return {
    url: canonicalUrl(originUrlOf(checkout)),
    defaultBranch,
    originAheadWarning: originAheadWarning(checkout, defaultBranch),
  };
}

function defaultBranchOfUrl(url: string): string {
  const remote = git(process.cwd(), ["ls-remote", "--symref", url, "HEAD"]);
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.out)?.[1];
  return branch ?? "main";
}

export function resolveSpecRef(
  value: string,
  cwd: string,
  projectRepos: { name: string; url: string; defaultBranch: string }[],
): ResolvedSpecRef {
  const path = resolve(cwd, value);
  if (isDirectory(path)) return fromDirectory(path);
  if (looksLikeAddress(value)) {
    return {
      url: canonicalUrl(value),
      defaultBranch: defaultBranchOfUrl(value),
    };
  }
  const named = projectRepos.find((repo) => repo.name === value);
  if (!named) {
    throw new SpecRefError(
      `${value} is not a local directory, a clone address, or a repo of this project`,
    );
  }
  return { url: named.url, defaultBranch: named.defaultBranch };
}

export function lsRemoteSha(url: string, defaultBranch: string): string {
  const result = git(process.cwd(), [
    "ls-remote",
    url,
    `refs/heads/${defaultBranch}`,
  ]);
  const sha = /^([0-9a-f]{40})\b/i.exec(result.out)?.[1];
  if (!result.ok || !sha) {
    throw new SpecRefError(`could not read ${url} refs/heads/${defaultBranch}`);
  }
  return sha.toLowerCase();
}

export type SpecRefView = {
  name: string;
  url: string;
  sha: string | null;
};

export function formatSpecRefs(refs: SpecRefView[]): string {
  if (refs.length === 0) return "参考仓库：无";
  return [
    "参考仓库：",
    ...refs.map(
      (ref) => `  ${ref.name}  ${ref.url}  ${ref.sha ?? "确认时钉住"}`,
    ),
  ].join("\n");
}

const BACKTICK = /`([^`\n]+)`/g;

export function backtickWords(body: string): string[] {
  return [...body.matchAll(BACKTICK)].map((match) => match[1]?.trim() ?? "");
}

export function siblingGitCheckouts(
  cwd: string,
): { name: string; dir: string }[] {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return [];
  const parent = dirname(top.out);
  let entries: string[] = [];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const found: { name: string; dir: string }[] = [];
  for (const name of entries) {
    const dir = resolve(parent, name);
    if (dir === top.out) continue;
    if (!isDirectory(dir)) continue;
    if (
      !existsSync(resolve(dir, ".git")) &&
      !git(dir, ["rev-parse", "--git-dir"]).ok
    ) {
      continue;
    }
    found.push({ name: basename(dir), dir });
  }
  return found;
}

export function missingRefWarnings(input: {
  body: string;
  specDisplayId: string;
  attachedNames: Iterable<string>;
  platformRepoNames: Iterable<string>;
  siblingCheckouts: { name: string; dir: string }[];
}): string[] {
  const attached = new Set(input.attachedNames);
  const platform = new Set(input.platformRepoNames);
  const siblings = new Map(
    input.siblingCheckouts.map((item) => [item.name, item.dir]),
  );
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const word of backtickWords(input.body)) {
    if (word === "" || attached.has(word) || seen.has(word)) continue;
    const sibling = siblings.get(word);
    const registered = platform.has(word);
    if (!registered && !sibling) continue;
    seen.add(word);
    const target = sibling ?? word;
    warnings.push(
      `spec mentions \`${word}\` but it is not a reference repo of ${input.specDisplayId}: plat spec edit ${input.specDisplayId} --ref ${target}`,
    );
  }
  return warnings;
}
