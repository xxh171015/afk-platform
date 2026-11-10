import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type HostKind,
  hostKindOfUrl,
  mixedHostsProblem,
  repoHost,
  repoHtmlUrl,
  tryParseRepoUrl,
} from "@afk/shared";

// `plat init`: what it reads from the local checkouts and what it plans to register. Registering and writing the
// tracker doc happen in index.ts; nothing here talks to the API or writes a file.

export class InitError extends Error {}

export const TRACKER_DOC_PATH = "docs/agents/issue-tracker.md";
export const DEFAULT_PROTECTED_PATHS = [".github/**"];
export const defaultProtectedPaths = (hostKind: HostKind): string[] =>
  hostKind === "gitlab" ? [".gitlab-ci.yml"] : DEFAULT_PROTECTED_PATHS;

// What a repo needs before the platform can take its tickets (GLOSSARY「Repo readiness」). Missing ones are only
// reported: registering does not depend on them.
// The sandbox image is the platform's, not the repo's (it runs every repo's tickets).
const READINESS_FILES = [".sandcastle/gates.yaml", "AGENTS.md"];
// Needed only when an integration ticket runs against the repo, which init cannot know yet.
const INTEGRATION_COMPOSE = ".sandcastle/integration/compose.yaml";

export interface Checkout {
  dir: string;
  url: string; // the https clone address the platform registers
  repoName: string; // the repo's name on its code host
  hostKind: HostKind;
  defaultBranch: string;
  defaultBranchConfirmed: boolean; // false when the remote could not be asked
  contractCandidates: string[];
  missing: string[];
  hasIntegrationCompose: boolean;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    // Never wait for a password or a host key: a remote that cannot be asked is reported, not prompted for.
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

export function inspectCheckout(path: string, cwd: string): Checkout {
  const given = resolve(cwd, path);
  if (!existsSync(given)) throw new InitError(`${path}: no such directory`);
  const top = git(given, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new InitError(`${path}: not a git checkout`);
  const dir = top.out;
  // The address as written in the config: `git remote get-url` would apply url.*.insteadOf rewrites.
  const origin = git(dir, ["config", "--get", "remote.origin.url"]);
  if (!origin.ok || origin.out === "") {
    throw new InitError(`${dir}: has no origin remote`);
  }
  const ref = tryParseRepoUrl(origin.out);
  const html = repoHtmlUrl(origin.out);
  if (!ref || !html) {
    throw new InitError(
      `${dir}: origin ${origin.out} is not a code host address`,
    );
  }
  const head = git(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.out)?.[1];
  return {
    dir,
    url: `${html}.git`,
    repoName: ref.name,
    hostKind: hostKindOfUrl(origin.out),
    defaultBranch: branch ?? "main",
    defaultBranchConfirmed: head.ok && branch !== undefined,
    contractCandidates: findContracts(dir),
    missing: READINESS_FILES.filter((file) => !existsSync(join(dir, file))),
    hasIntegrationCompose: existsSync(join(dir, INTEGRATION_COMPOSE)),
  };
}

function findContracts(dir: string, prefix = "", depth = 0): string[] {
  if (depth > 5) return [];
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...findContracts(dir, path, depth + 1));
    else if (/^openapi[^/]*\.(ya?ml|json)$/i.test(entry.name)) found.push(path);
  }
  return found.sort();
}

export interface RegisteredRepo {
  name: string;
  url: string;
  defaultBranch: string;
  contractPath: string | null;
  hostKind: HostKind;
}

export interface PlannedRepo {
  checkout: Checkout;
  name: string;
  planning: boolean;
  registered: boolean;
  contractPath: string | null; // what a new repo is registered with
  notes: string[];
}

export interface InitPlan {
  project:
    | { kind: "existing"; id: number; name: string }
    | { kind: "new"; name: string; protectedPaths: string[] };
  repos: PlannedRepo[];
}

const sameRepo = (a: string, b: string) => {
  const left = tryParseRepoUrl(a);
  const right = tryParseRepoUrl(b);
  return left && right
    ? left.owner === right.owner && left.name === right.name
    : a === b;
};

export function planInit(input: {
  project:
    | { id: number; name: string; repos: RegisteredRepo[] }
    | { newName: string };
  planning: Checkout;
  others: { checkout: Checkout; name?: string }[];
  contractPath?: string;
}): InitPlan {
  const registered = "id" in input.project ? input.project.repos : [];
  const projectId = "id" in input.project ? input.project.id : "<id>";
  const taken = new Set(registered.map((r) => r.name));
  const all = [
    { checkout: input.planning, name: undefined, planning: true },
    ...input.others.map((o) => ({ ...o, planning: false })),
  ];
  const repos: PlannedRepo[] = [];
  for (const { checkout, name, planning } of all) {
    if (repos.some((r) => sameRepo(r.checkout.url, checkout.url))) {
      throw new InitError(`${checkout.dir}: given twice`);
    }
    const existing = registered.find((r) => sameRepo(r.url, checkout.url));
    const notes: string[] = [];
    const edit = (flag: string, value: string, what: string) =>
      notes.push(
        `${what}; to change it: plat repo edit ${existing?.name} --project ${projectId} ${flag} ${value}`,
      );
    let contractPath: string | null = null;
    if (planning) {
      const candidates = input.planning.contractCandidates;
      contractPath =
        input.contractPath ??
        (candidates.length === 1 ? (candidates[0] as string) : null);
      if (contractPath === null && !existing) {
        notes.push(
          candidates.length === 0
            ? "no openapi file found, so no contract path; give one with --contract-path if this repo has a contract"
            : `several openapi files (${candidates.join(", ")}), so no contract path; pick one with --contract-path`,
        );
      }
    }
    if (existing) {
      if (name !== undefined && name !== existing.name) {
        notes.push(`already registered as ${existing.name}; the name is kept`);
      }
      if (existing.hostKind !== checkout.hostKind) {
        edit(
          "--host-kind",
          checkout.hostKind,
          `registered on ${existing.hostKind}, the address says ${checkout.hostKind}`,
        );
      }
      if (
        checkout.defaultBranchConfirmed &&
        existing.defaultBranch !== checkout.defaultBranch
      ) {
        notes.push(
          `registered with default branch ${existing.defaultBranch}, the remote's is ${checkout.defaultBranch}`,
        );
      }
      if (
        planning &&
        contractPath !== null &&
        existing.contractPath !== contractPath
      ) {
        edit(
          "--contract-path",
          contractPath,
          `registered with contract path ${existing.contractPath ?? "(none)"}, found ${contractPath}`,
        );
      }
      repos.push({
        checkout,
        name: existing.name,
        planning,
        registered: true,
        contractPath: existing.contractPath,
        notes,
      });
      continue;
    }
    const chosen = name ?? checkout.repoName;
    if (taken.has(chosen)) {
      throw new InitError(
        `the project already has a repo named ${chosen} at another address; give this one another name: --with ${checkout.dir}=<name>`,
      );
    }
    taken.add(chosen);
    if (!checkout.defaultBranchConfirmed) {
      notes.push(
        `could not ask the remote for its default branch, so it is taken to be ${checkout.defaultBranch}`,
      );
    }
    repos.push({
      checkout,
      name: chosen,
      planning,
      registered: false,
      contractPath,
      notes,
    });
  }
  return {
    project:
      "id" in input.project
        ? {
            kind: "existing",
            id: input.project.id,
            name: input.project.name,
          }
        : {
            kind: "new",
            name: input.project.newName,
            protectedPaths: defaultProtectedPaths(input.planning.hostKind),
          },
    repos,
  };
}

export function planText(plan: InitPlan): string {
  const lines: string[] = [];
  lines.push(
    plan.project.kind === "new"
      ? `project: new, ${plan.project.name} (protected paths: ${plan.project.protectedPaths.join(", ")})`
      : `project: ${plan.project.id} ${plan.project.name}`,
  );
  lines.push("repos:");
  for (const repo of plan.repos) {
    const c = repo.checkout;
    const facts = [
      repo.registered ? "registered" : "new",
      ...(repo.planning ? ["planning repo"] : []),
      c.url,
      c.hostKind,
      `branch ${c.defaultBranch}${c.defaultBranchConfirmed ? "" : " (unconfirmed)"}`,
      ...(repo.contractPath ? [`contract ${repo.contractPath}`] : []),
    ];
    lines.push(`  ${repo.name}: ${facts.join(", ")}`);
    for (const note of repo.notes) lines.push(`    - ${note}`);
    lines.push(
      c.missing.length === 0
        ? "    - readiness: gates and AGENTS.md are there"
        : `    - readiness: missing ${c.missing.join(", ")}`,
    );
    lines.push(
      `    - ${c.hasIntegrationCompose ? "has" : "no"} ${INTEGRATION_COMPOSE} (needed only if an integration ticket runs against it)`,
    );
  }
  lines.push(
    `tracker doc: written to ${TRACKER_DOC_PATH} in the planning repo, on this machine only unless the repo tracks it`,
  );
  return lines.join("\n");
}

export const hasRegistrations = (plan: InitPlan) =>
  plan.project.kind === "new" || plan.repos.some((r) => !r.registered);

// `--with <path>[=<name>]`
export function parseWith(value: string): { path: string; name?: string } {
  const at = value.lastIndexOf("=");
  if (at <= 0) return { path: value };
  const name = value.slice(at + 1);
  if (name === "") throw new InitError(`--with ${value}: empty name`);
  return { path: value.slice(0, at), name };
}

export interface KnownHost {
  host: string;
  kind: HostKind;
}

// A checkout is on the kind of host a worker reported for its host; one on a host no worker has credentials for
// keeps what its address suggests, and codeHostProblems names it.
export function withKnownHostKind(
  checkout: Checkout,
  known: readonly KnownHost[],
): Checkout {
  const host = repoHost(checkout.url);
  const found = known.find((k) => k.host === host);
  return found ? { ...checkout, hostKind: found.kind } : checkout;
}

// What stops plat init before it registers anything: a repo on a host no worker has credentials for, or repos on
// different kinds of host (docs/specs/m3-platform.md「托管类型与接入」). Said in Chinese, with the fix.
export function codeHostProblems(
  plan: InitPlan,
  known: readonly KnownHost[],
): string[] {
  const problems: string[] = [];
  const unknown = plan.repos.filter(
    (repo) =>
      !repo.registered &&
      !known.some((k) => k.host === repoHost(repo.checkout.url)),
  );
  if (unknown.length > 0 && known.length === 0)
    problems.push("还没有 worker 向平台报过它有凭据的主机：先启动 worker。");
  for (const repo of unknown)
    problems.push(
      unknownHostProblem(repo.name, repo.checkout.url, known) as string,
    );
  const mixed = mixedHostsProblem(
    plan.repos.map((repo) => ({
      name: repo.name,
      hostKind: repo.checkout.hostKind,
    })),
  );
  if (mixed) problems.push(mixed);
  return problems;
}

// A repo on a host no worker has credentials for: what to tell the person; null when a worker has, or when the
// address names no host (a local path, in tests).
export function unknownHostProblem(
  name: string,
  url: string,
  known: readonly KnownHost[],
): string | null {
  const host = repoHost(url);
  if (!host || known.some((k) => k.host === host)) return null;
  return `${name} 在 ${host}，平台没有这台主机的凭据：GitHub 上的仓库要装 GitHub App（\`~/.afk/secrets/github-app\`）；GitLab 上的，把 GitLab 的 PAT 放到 \`~/.afk/secrets/gitlab/${host}\`，重启 worker 后再跑 /afk-setup。`;
}
