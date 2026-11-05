import { basename } from "node:path";
import { git } from "./exec.ts";
import { changedFiles } from "./protected-paths.ts";

// The contract copy check (docs/specs/m2-platform.md「契约副本检查」): the consumer repo commits a copy of the
// contract it builds against, and the copy must be byte for byte the contract at the SHA the platform pinned.
// A ticket without contract edges may not touch a copy at all. Only other repos' contracts are copied: a
// contract edge from the ticket's own repo pins what the agent reads, and the repo has the contract itself.

const COPY_DIR = "contract/";

export interface ContractCopyProblem {
  file: string;
  detail: string;
}

export interface ProvidedContract {
  repo: string;
  path: string; // in the providing repo
  content: string; // the file at the pinned SHA
}

// contract/<file> for one providing repo, contract/<repo>/<file> when there are several.
export const copyPathOf = (contract: ProvidedContract, providers: number) =>
  providers > 1
    ? `${COPY_DIR}${contract.repo}/${basename(contract.path)}`
    : `${COPY_DIR}${basename(contract.path)}`;

export function checkContractCopies(input: {
  repoDir: string;
  repo: string; // the ticket's repo
  ref: string; // the ticket's branch
  base: string; // where the branch left the integration branch
  contracts: readonly ProvidedContract[];
}): ContractCopyProblem[] {
  const { repoDir, ref } = input;
  const contracts = input.contracts.filter((c) => c.repo !== input.repo);
  if (contracts.length === 0) {
    return changedFiles(repoDir, input.base, ref)
      .filter((file) => file.startsWith(COPY_DIR))
      .map((file) => ({
        file,
        detail: `${file} is a contract copy, but this ticket has no contract edge from another repo, so it may not change it`,
      }));
  }
  const problems: ContractCopyProblem[] = [];
  for (const contract of contracts) {
    const file = copyPathOf(contract, contracts.length);
    const shown = git(repoDir, ["show", `${ref}:${file}`]);
    if (shown.code !== 0) {
      problems.push({
        file,
        detail: `${file} is missing; commit a copy of ${contract.repo}'s contract (${contract.path})`,
      });
    } else if (shown.stdout !== contract.content) {
      problems.push({
        file,
        detail: `${file} differs from ${contract.repo}'s contract (${contract.path}): ${describeDifference(contract.content, shown.stdout)}`,
      });
    }
  }
  return problems;
}

const clip = (line: string | undefined) =>
  line === undefined ? "(nothing)" : JSON.stringify(line.slice(0, 80));

function describeDifference(expected: string, actual: string): string {
  const want = expected.split("\n");
  const have = actual.split("\n");
  const at = want.findIndex((line, i) => line !== have[i]);
  if (at === -1 && want.length === have.length) return "the files are equal";
  const index = at === -1 ? Math.min(want.length, have.length) : at;
  return `line ${index + 1}: expected ${clip(want[index])}, found ${clip(have[index])}`;
}
