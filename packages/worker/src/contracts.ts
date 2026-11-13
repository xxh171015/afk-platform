import { readContract } from "@afk/pipeline";
import type { Bundle } from "@afk/shared";
import type { RepoStore } from "./repos.ts";

// Each contract file the ticket builds against, read in the main clone of the repo that provides it (cloned or
// brought up to date first), at the SHA the contract ticket recorded.
export async function fetchContracts(
  repos: RepoStore,
  contracts: Bundle["contracts"],
): Promise<{ repo: string; path: string; content: string }[]> {
  const read: { repo: string; path: string; content: string }[] = [];
  for (const contract of contracts) {
    const dir = await repos.ensure(
      contract.repo,
      contract.url,
      contract.defaultBranch,
    );
    read.push({ repo: contract.repo, ...readContract(dir, contract) });
  }
  return read;
}
