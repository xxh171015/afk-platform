import { AUTHOR, git, gitOrThrow } from "./exec.ts";

export const RECHECK_REF_PREFIX = "refs/afk/recheck/";

// Automatic merge of the pre-run tip and the incoming commit, as a commit nothing else points at. Recheck diffs
// this tree against the agent's result so incoming's own test edits do not count. Conflict markers stay in the
// tree, so resolving a conflict by dropping a side's test lines still shows up.
export function autoMergeCommit(input: {
  repoDir: string;
  oursSha: string;
  theirsSha: string;
  ref: string;
}): string {
  const merged = git(input.repoDir, [
    "merge-tree",
    "--write-tree",
    input.oursSha,
    input.theirsSha,
  ]);
  const tree = merged.stdout.trim().split("\n")[0] ?? "";
  if (
    (merged.code !== 0 && merged.code !== 1) ||
    !/^[0-9a-f]{40,64}$/.test(tree)
  ) {
    throw new Error(`git merge-tree failed: ${merged.out.slice(0, 400)}`);
  }
  const sha = gitOrThrow(
    input.repoDir,
    [
      "commit-tree",
      tree,
      "-p",
      input.oursSha,
      "-p",
      input.theirsSha,
      "-m",
      "auto-merge for Recheck",
    ],
    {
      ...AUTHOR,
      GIT_AUTHOR_DATE: "1000000000 +0000",
      GIT_COMMITTER_DATE: "1000000000 +0000",
    },
  );
  gitOrThrow(input.repoDir, ["update-ref", input.ref, sha]);
  return sha;
}

// Recreate the auto-merge commit when this clone never stored it (another worker ran update-branch /
// merge-fix). Same tree, parents, message and dates yield the same SHA.
export function ensureRecheckFromSha(
  repoDir: string,
  fromSha: string,
  toSha: string,
): void {
  if (git(repoDir, ["cat-file", "-e", `${fromSha}^{commit}`]).code === 0)
    return;
  const merge = git(repoDir, [
    "rev-list",
    "--merges",
    "-n",
    "1",
    toSha,
  ]).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(merge)) {
    throw new Error(
      `cannot reconstruct Recheck auto-merge ${fromSha}: no merge commit under ${toSha}`,
    );
  }
  const oursSha = gitOrThrow(repoDir, ["rev-parse", `${merge}^1`]);
  const theirsSha = gitOrThrow(repoDir, ["rev-parse", `${merge}^2`]);
  const created = autoMergeCommit({
    repoDir,
    oursSha,
    theirsSha,
    ref: `${RECHECK_REF_PREFIX}${fromSha}`,
  });
  if (created !== fromSha) {
    throw new Error(
      `reconstructed auto-merge ${created} does not match Recheck fromSha ${fromSha}`,
    );
  }
}

// Deterministic Recheck trigger (GLOSSARY Recheck): review-fix / merge-fix / final-fix / update-branch
// changed existing test lines or test/build config. No agent. gates.yaml `recheckConfig` adds paths.

export const DEFAULT_RECHECK_CONFIG_PATHS = [
  ".sandcastle/gates.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "playwright.config.ts",
  "playwright.config.js",
  "cypress.config.ts",
  "biome.json",
  "eslint.config.js",
  "eslint.config.ts",
  ".eslintrc.js",
  ".eslintrc.json",
  "tsconfig.json",
  "turbo.json",
  "Makefile",
  "pyproject.toml",
  "pytest.ini",
  "setup.cfg",
  "tox.ini",
  "Cargo.toml",
  "go.mod",
  "meson.build",
  "CMakeLists.txt",
  ".github/workflows",
] as const;

export type RecheckTrigger = {
  hit: boolean;
  paths: string[];
  fromSha: string;
  toSha: string;
};

export function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  if (path.includes("/__tests__/")) return true;
  return /(^|\/)tests?\//.test(path);
}

export function isConfigPath(
  path: string,
  extra: readonly string[] = [],
): boolean {
  for (const listed of [...DEFAULT_RECHECK_CONFIG_PATHS, ...extra]) {
    if (path === listed) return true;
    if (listed.endsWith("/") && path.startsWith(listed)) return true;
    if (!listed.endsWith("/") && path.startsWith(`${listed}/`)) return true;
  }
  return false;
}

function existedAt(repoDir: string, sha: string, path: string): boolean {
  return git(repoDir, ["cat-file", "-e", `${sha}:${path}`]).code === 0;
}

function hasDeletedLines(
  repoDir: string,
  fromSha: string,
  toSha: string,
  path: string,
): boolean {
  if (!existedAt(repoDir, toSha, path)) return true;
  const diff = gitOrThrow(repoDir, ["diff", "-U0", fromSha, toSha, "--", path]);
  return diff
    .split("\n")
    .some((line) => line.startsWith("-") && !line.startsWith("---"));
}

export function recheckHit(input: {
  repoDir: string;
  fromSha: string;
  toSha: string;
  // Commit the ticket started from (integration merge-base). Omit to treat fromSha as the baseline.
  baselineSha?: string;
  extraConfigPaths?: readonly string[];
}): RecheckTrigger {
  if (input.fromSha === input.toSha) {
    return {
      hit: false,
      paths: [],
      fromSha: input.fromSha,
      toSha: input.toSha,
    };
  }
  const changed = gitOrThrow(input.repoDir, [
    "diff",
    "--name-only",
    input.fromSha,
    input.toSha,
  ])
    .split("\n")
    .filter(Boolean);
  const extra = input.extraConfigPaths ?? [];
  const paths: string[] = [];
  for (const path of changed) {
    if (isConfigPath(path, extra)) {
      paths.push(path);
      continue;
    }
    if (!isTestPath(path)) continue;
    // Ticket baseline (merge-base with integration), not this stage's start: tests this ticket added are skipped.
    if (!existedAt(input.repoDir, input.baselineSha ?? input.fromSha, path))
      continue;
    if (hasDeletedLines(input.repoDir, input.fromSha, input.toSha, path))
      paths.push(path);
  }
  return {
    hit: paths.length > 0,
    paths,
    fromSha: input.fromSha,
    toSha: input.toSha,
  };
}
