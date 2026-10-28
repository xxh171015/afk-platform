import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitOrThrow } from "../exec.ts";

// A throwaway git repository for tests, with a first commit on `main`.
export interface TestRepo {
  dir: string;
  commit(files: Record<string, string>, message: string): string;
  cleanup(): void;
}

export function makeRepo(
  initial: Record<string, string> = { "README.md": "# repo\n" },
): TestRepo {
  const root = mkdtempSync(join(tmpdir(), "afk-pipeline-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, ["init", "--quiet", "--initial-branch", "main"]);
  gitOrThrow(dir, ["config", "user.name", "Test"]);
  gitOrThrow(dir, ["config", "user.email", "test@example.com"]);
  gitOrThrow(dir, ["config", "commit.gpgsign", "false"]);
  const repo: TestRepo = {
    dir,
    commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      gitOrThrow(dir, ["add", "-A"]);
      gitOrThrow(dir, ["commit", "--quiet", "-m", message]);
      return gitOrThrow(dir, ["rev-parse", "HEAD"]);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  repo.commit(initial, "initial");
  return repo;
}

export const tmpPath = (name: string, repo: TestRepo) =>
  join(dirname(repo.dir), name);
