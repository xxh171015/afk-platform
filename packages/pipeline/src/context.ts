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
  // Planning commit files (GLOSSARY.md, docs/adr/**). Omit for the planning repo's own tickets.
  domain?: { path: string; content: string }[];
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
    defaultBranch: bundle.repo.defaultBranch,
    allowedProtectedPaths: bundle.allowedProtectedPaths,
    fixCounts: bundle.ticket?.fixCounts ?? null,
    contracts: bundle.contracts.map((c) => ({
      repo: c.repo,
      sha: c.sha,
      file: contractFile(c.repo, c.path),
    })),
    domain: input.domain?.length
      ? input.domain.map((file) => domainFile(file.path))
      : null,
  };
}

// The agent sees each contract under /context/contract/<repo>/.
const contractFile = (repo: string, path: string) =>
  `contract/${repo}/${basename(path)}`;

// The agent sees planning docs under /context/domain/, mirroring the planning repo.
const domainFile = (path: string) => `domain/${path}`;

const DOMAIN_TREE = ["GLOSSARY.md", "docs/adr"];

export function renderContext(input: ContextInput): void {
  const { dir, bundle } = input;
  mkdirSync(dir, { recursive: true });
  if (bundle.ticket) {
    writeFileSync(join(dir, "ticket.md"), bundle.ticket.file);
  } else {
    // a finalization has no ticket of its own: it is given what all the tickets set out to do
    writeFileSync(join(dir, "tickets.md"), specTicketsMarkdown(bundle));
  }
  writeFileSync(
    join(dir, "spec.md"),
    `# ${bundle.spec.displayId} ${bundle.spec.title}\n\n${bundle.spec.body}\n`,
  );
  writeFileSync(join(dir, "run.json"), JSON.stringify(runJson(input), null, 2));
  if (bundle.note) {
    writeFileSync(join(dir, "note.md"), bundle.note);
  }
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
  for (const file of input.domain ?? []) {
    const dest = join(dir, domainFile(file.path));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
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

// GLOSSARY.md and docs/adr/** at a planning SHA. Never AGENTS.md, never the rest of the repo.
export function readDomainFiles(
  repoDir: string,
  sha: string,
): { path: string; content: string }[] {
  const listed = git(repoDir, [
    "ls-tree",
    "-r",
    "--name-only",
    sha,
    "--",
    ...DOMAIN_TREE,
  ]);
  if (listed.code !== 0) {
    throw new Error(`git ls-tree ${sha} failed: ${listed.out.slice(0, 400)}`);
  }
  const paths = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => path === "GLOSSARY.md" || path.startsWith("docs/adr/"));
  return paths.map((path) => ({
    path,
    content: readContract(repoDir, { sha, path }).content,
  }));
}
