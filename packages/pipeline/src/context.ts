import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Bundle } from "@afk/shared";
import { git } from "./exec.ts";

// Renders /context for an agent run (docs/design.md「Agent 与 skills 对接」): the files the agent reads, and
// nothing else. The prompt only points at them.

export interface RunFacts {
  runId: string; // R-<n>
  baseSha: string; // what the review diffs against
  branch: string; // agent/<id>/<ticket id>
}

export interface ContextInput {
  dir: string;
  bundle: Bundle;
  run: RunFacts;
  failureLog?: string; // gate-fix and merge-fix: the tail of the failing gate
  review?: unknown; // review-fix: the review's structured result
  contracts?: { repo: string; path: string; content: string }[]; // each contract file at its recorded SHA
}

function ticketMarkdown(bundle: Bundle): string {
  const { ticket } = bundle;
  if (!ticket) return "";
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

function specTicketsMarkdown(bundle: Bundle): string {
  return [
    `# Tickets of ${bundle.spec.displayId}`,
    "",
    ...bundle.specTickets.flatMap((t) => [
      `## ${t.displayId} ${t.title}`,
      ...t.acceptanceCriteria.map((c) => `- ${c}`),
      "",
    ]),
  ].join("\n");
}

function runJson(input: ContextInput) {
  const { bundle, run } = input;
  return {
    stage: bundle.job.stage,
    runId: run.runId,
    ticket: bundle.ticket?.displayId ?? null,
    spec: bundle.spec.displayId,
    baseSha: run.baseSha,
    branch: run.branch,
    integrationBranch: bundle.integrationBranch,
    allowedProtectedPaths: bundle.allowedProtectedPaths,
    fixCounts: bundle.ticket?.fixCounts ?? null,
    contracts: bundle.contracts.map((c) => ({
      repo: c.repo,
      sha: c.sha,
      file: contractFile(c.repo, c.path),
    })),
  };
}

// The agent sees each contract under /context/contract/<repo>/.
const contractFile = (repo: string, path: string) =>
  `contract/${repo}/${basename(path)}`;

export function renderContext(input: ContextInput): void {
  const { dir, bundle } = input;
  mkdirSync(dir, { recursive: true });
  if (bundle.ticket) {
    writeFileSync(join(dir, "ticket.md"), ticketMarkdown(bundle));
  } else {
    // a finalization has no ticket of its own: it is given what all the tickets set out to do
    writeFileSync(join(dir, "tickets.md"), specTicketsMarkdown(bundle));
  }
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
  for (const contract of input.contracts ?? []) {
    const file = join(dir, contractFile(contract.repo, contract.path));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contract.content);
  }
}

// The contract as it was when its ticket merged: `git show <sha>:<path>` in the clone of the repo that holds it.
export function readContract(
  repoDir: string,
  contract: { sha: string; path: string },
): { path: string; content: string } {
  const { path } = contract;
  const shown = git(repoDir, ["show", `${contract.sha}:${path}`]);
  if (shown.code !== 0) {
    throw new Error(
      `git show ${contract.sha}:${path} failed: ${shown.out.slice(0, 400)}`,
    );
  }
  // the file exactly as committed, trailing newline included
  return { path, content: shown.stdout };
}
