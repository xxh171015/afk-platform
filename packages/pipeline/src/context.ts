import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Bundle } from "@afk/shared";
import { git } from "./exec.ts";

// Renders /context for an agent run (docs/design.md「Agent 与 skills 对接」): the files the agent reads, and
// nothing else. The prompt only points at them.

export interface RunFacts {
  runId: string; // R-<n>
  baseSha: string; // what the review diffs against
  branch: string; // agent/<ticket id>
}

export interface ContextInput {
  dir: string;
  bundle: Bundle;
  run: RunFacts;
  failureLog?: string; // gate-fix and merge-fix: the tail of the failing gate
  review?: unknown; // review-fix: the review's structured result
  contract?: { path: string; content: string }; // the contract file at the recorded SHA
}

function ticketMarkdown(bundle: Bundle): string {
  const { ticket } = bundle;
  return [
    `# ${ticket.displayId} ${ticket.title}`,
    "",
    `Type: ${ticket.type}`,
    "",
    "## Acceptance criteria",
    ...ticket.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Modules",
    ...ticket.modules.map((glob) => `- ${glob}`),
    "",
    ticket.body ? `## Details\n\n${ticket.body}` : "",
  ].join("\n");
}

function runJson(input: ContextInput) {
  const { bundle, run } = input;
  return {
    stage: bundle.job.stage,
    runId: run.runId,
    ticket: bundle.ticket.displayId,
    spec: bundle.spec.displayId,
    baseSha: run.baseSha,
    branch: run.branch,
    integrationBranch: bundle.integrationBranch,
    allowedProtectedPaths: bundle.allowedProtectedPaths,
    fixCounts: bundle.ticket.fixCounts,
    contract: bundle.contract
      ? { sha: bundle.contract.sha, file: contractFile(bundle.contract.path) }
      : null,
  };
}

// The contract path is "<repo role>:<path in that repo>"; the agent sees it under /context/contract/.
const contractFile = (path: string) =>
  `contract/${basename(path.slice(path.indexOf(":") + 1))}`;

export function renderContext(input: ContextInput): void {
  const { dir, bundle } = input;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), ticketMarkdown(bundle));
  writeFileSync(
    join(dir, "spec.md"),
    `# ${bundle.spec.displayId} ${bundle.spec.title}\n\n${bundle.spec.body}\n`,
  );
  writeFileSync(join(dir, "run.json"), JSON.stringify(runJson(input), null, 2));
  if (input.failureLog !== undefined) {
    mkdirSync(join(dir, "failure"), { recursive: true });
    writeFileSync(join(dir, "failure", "gate.log"), input.failureLog);
  }
  if (input.review !== undefined) {
    writeFileSync(
      join(dir, "review.json"),
      JSON.stringify(input.review, null, 2),
    );
  }
  if (input.contract && bundle.contract) {
    mkdirSync(join(dir, "contract"), { recursive: true });
    writeFileSync(
      join(dir, contractFile(bundle.contract.path)),
      input.contract.content,
    );
  }
}

// The contract as it was when its ticket merged: `git show <sha>:<path>` in the clone of the repo that holds it.
export function readContract(
  repoDir: string,
  contract: NonNullable<Bundle["contract"]>,
): { path: string; content: string } {
  const path = contract.path.slice(contract.path.indexOf(":") + 1);
  const shown = git(repoDir, ["show", `${contract.sha}:${path}`]);
  if (shown.code !== 0) {
    throw new Error(
      `git show ${contract.sha}:${path} failed: ${shown.out.slice(0, 400)}`,
    );
  }
  // the file exactly as committed, trailing newline included
  return { path, content: shown.stdout };
}
