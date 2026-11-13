import { git, gitOrThrow } from "./exec.ts";

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
