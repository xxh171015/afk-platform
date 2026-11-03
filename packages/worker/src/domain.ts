import { gitOrThrow, readDomainFiles } from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { PushFn } from "./push.ts";
import type { RepoStore } from "./repos.ts";

// GLOSSARY.md and docs/adr at the planning SHA, for tickets that are not in the planning repo.
export function fetchDomain(
  repos: RepoStore,
  domain: Bundle["domain"],
  ticketRepo: string,
): { path: string; content: string }[] | undefined {
  if (!domain || domain.repo === ticketRepo) return undefined;
  const dir = repos.ensure(domain.repo, domain.url, domain.defaultBranch);
  repos.fetchObject(dir, domain.url, domain.sha);
  return readDomainFiles(dir, domain.sha);
}

// First cut of this spec's integration branch: planning SHA in the planning repo, else the default branch.
export function cutIntegrationBranch(
  repos: Pick<RepoStore, "has" | "fetchObject">,
  push: PushFn,
  mainDir: string,
  bundle: Bundle,
): void {
  const branch = bundle.integrationBranch as string;
  if (repos.has(mainDir, `refs/heads/${branch}`)) return;
  const planning =
    bundle.domain?.repo === bundle.repo.name ? bundle.domain : null;
  if (planning) repos.fetchObject(mainDir, planning.url, planning.sha);
  const base = planning
    ? planning.sha
    : gitOrThrow(mainDir, ["rev-parse", bundle.repo.defaultBranch]);
  gitOrThrow(mainDir, ["update-ref", `refs/heads/${branch}`, base]);
  const pushed = push({
    repoDir: mainDir,
    source: `refs/heads/${branch}`,
    target: `refs/heads/${branch}`,
    expectedOld: "",
  });
  if (!pushed.ok) {
    throw new Error(`could not create ${branch}: ${pushed.error}`);
  }
}
