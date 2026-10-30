import { readContract } from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { RepoStore } from "./repos.ts";

// Each contract file the ticket builds against, read in the main clone of the repo that provides it (cloned or
// brought up to date first), at the SHA the contract ticket recorded.
export function fetchContracts(
  repos: RepoStore,
  contracts: Bundle["contracts"],
): { repo: string; path: string; content: string }[] {
  return contracts.map((contract) => {
    const dir = repos.ensure(
      contract.repo,
      contract.url,
      contract.defaultBranch,
    );
    return { repo: contract.repo, ...readContract(dir, contract) };
  });
}
