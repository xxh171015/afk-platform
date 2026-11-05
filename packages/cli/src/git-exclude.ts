import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// Files plat writes into a checkout for this machine only: kept out of git through the repo's .git/info/exclude,
// which is never committed or pushed. Entries are `/<path>`, from the repo's top.

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, out: result.stdout ?? "" };
}

/** Whether git tracks `path` (from the repo's top) in this checkout. */
export const isTracked = (repo: string, path: string): boolean =>
  git(repo, ["ls-files", "--error-unmatch", "--", path]).code === 0;

function excludeFile(repo: string): string {
  const where = git(repo, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]).out.trim();
  return isAbsolute(where) ? where : join(repo, where);
}

const entry = (path: string) => `/${path.replace(/^\/+/, "")}`;

/** The entries for `paths` that the repo's .git/info/exclude lacks. */
export function missingExcludes(repo: string, paths: string[]): string[] {
  const file = excludeFile(repo);
  const have = new Set(
    existsSync(file) ? readFileSync(file, "utf8").split("\n") : [],
  );
  return [...new Set(paths.map(entry))].filter((line) => !have.has(line));
}

/** Adds the entries for `paths` the repo's .git/info/exclude lacks; returns the lines added. */
export function excludeLocally(repo: string, paths: string[]): string[] {
  const missing = missingExcludes(repo, paths);
  if (missing.length === 0) return [];
  const file = excludeFile(repo);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
  return missing;
}
