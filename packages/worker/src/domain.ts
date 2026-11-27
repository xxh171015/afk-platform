import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHOR,
  git,
  gitOrThrow,
  isAncestor,
  readDomainFiles,
} from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { PushFn } from "./push.ts";
import type { RepoStore } from "./repos.ts";
import { setupBase } from "./setup.ts";

export interface RecutIntegration {
  repo: { name: string; url: string; defaultBranch: string };
  branch: string;
  mainSha: string;
  planningSha?: string;
}

// GLOSSARY.md and docs/adr at the planning SHA, for tickets that are not in the planning repo.
export async function fetchDomain(
  repos: RepoStore,
  domain: Bundle["domain"],
  ticketRepo: string,
): Promise<{ path: string; content: string }[] | undefined> {
  if (!domain || domain.repo === ticketRepo) return undefined;
  const dir = await repos.ensure(domain.repo, domain.url, domain.defaultBranch);
  await repos.fetchObject(dir, domain.url, domain.sha);
  return readDomainFiles(dir, domain.sha);
}

// First cut of this spec's integration branch: the planning SHA in the planning repo (it has the setup commit
// already), else the setup commit (the default branch's head when there is no setup to merge).
export async function cutIntegrationBranch(
  repos: Pick<RepoStore, "has" | "fetchObject" | "fetchBranch">,
  push: PushFn,
  mainDir: string,
  bundle: Bundle,
  log: (line: string) => void = () => {},
): Promise<void> {
  const branch = bundle.integrationBranch as string;
  if (repos.has(mainDir, `refs/heads/${branch}`)) return;
  const planning =
    bundle.domain?.repo === bundle.repo.name ? bundle.domain : null;
  if (planning) await repos.fetchObject(mainDir, planning.url, planning.sha);
  const base = planning
    ? planning.sha
    : await setupBase(repos, mainDir, bundle.repo, log);
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, base]);
  const pushed = await push({
    repoDir: mainDir,
    source: `refs/heads/${branch}`,
    target: `refs/heads/${branch}`,
    expectedOld: "",
  });
  if (!pushed.ok) {
    // Two jobs can both create; the loser still proceeds if origin has the branch and it contains our start.
    if (
      (await repos.fetchBranch(mainDir, bundle.repo.url, branch)) &&
      isAncestor(mainDir, base, `refs/heads/${branch}`)
    ) {
      log(`integration branch ${branch} was created by another job`);
      return;
    }
    throw new Error(`could not create ${branch}: ${pushed.error}`);
  }
}

// Force-update an existing spec/* branch from current main (setup commit first), then replay the planning
// commit when this is the planning repo and it carried docs. Push with force-with-lease of the old tip.
export async function recutIntegrationBranch(
  repos: Pick<RepoStore, "has" | "fetchObject" | "fetchBranch">,
  push: PushFn,
  mainDir: string,
  input: RecutIntegration,
  log: (line: string) => void = () => {},
): Promise<void> {
  await repos.fetchObject(mainDir, input.repo.url, input.mainSha);
  const base = await setupBase(repos, mainDir, input.repo, log, input.mainSha);
  let tip = base;
  if (input.planningSha && input.planningSha !== input.mainSha) {
    await repos.fetchObject(mainDir, input.repo.url, input.planningSha);
    tip = replayPlanningOnto(mainDir, input.planningSha, base);
  }
  const ref = `refs/heads/${input.branch}`;
  let expectedOld = "";
  if (repos.has(mainDir, ref)) {
    expectedOld = gitOrThrow(mainDir, ["rev-parse", ref]);
  } else if (await repos.fetchBranch(mainDir, input.repo.url, input.branch)) {
    expectedOld = gitOrThrow(mainDir, ["rev-parse", ref]);
  }
  gitOrThrow(mainDir, ["update-ref", ref, tip]);
  const pushed = await push({
    repoDir: mainDir,
    source: ref,
    target: ref,
    expectedOld,
  });
  if (!pushed.ok)
    throw new Error(`could not recut ${input.branch}: ${pushed.error}`);
  log(`recut ${input.branch} to ${tip}`);
}

function replayPlanningOnto(
  dir: string,
  planningSha: string,
  onto: string,
): string {
  const parents = gitOrThrow(dir, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    planningSha,
  ])
    .trim()
    .split(" ");
  if (parents.length !== 2) return onto;
  const parent = parents[1];
  const patch = git(dir, ["diff", parent, planningSha]).stdout;
  if (patch.trim() === "") return onto;
  const scratch = mkdtempSync(join(tmpdir(), "afk-recut-planning-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    gitOrThrow(dir, ["read-tree", onto], env);
    const applied = git(
      dir,
      ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"],
      env,
      patch,
    );
    if (applied.code !== 0) {
      throw new Error(
        `the planning commit does not apply onto the new cut: ${applied.out.slice(0, 400)}`,
      );
    }
    const tree = gitOrThrow(dir, ["write-tree"], env);
    if (tree === gitOrThrow(dir, ["rev-parse", `${onto}^{tree}`])) return onto;
    const message = gitOrThrow(dir, ["log", "-1", "--format=%B", planningSha]);
    const commit = git(
      dir,
      ["commit-tree", tree, "-p", onto, "-F", "-"],
      AUTHOR,
      message.endsWith("\n") ? message : `${message}\n`,
    );
    if (commit.code !== 0)
      throw new Error(`commit-tree failed: ${commit.out.slice(0, 400)}`);
    return commit.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
