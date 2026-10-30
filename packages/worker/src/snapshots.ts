import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { exec, gitOrThrow } from "@afk/pipeline";

// Read-only snapshots of other repos at a pinned SHA, mounted at /refs/<repo> (docs/specs/m2-platform.md「只读快照」).
// A snapshot is a directory <name>@<sha> that is either whole or not there: it is built in a temporary
// directory next to it and renamed into place, so a crash or a failed export never leaves half of one to reuse.
// Known limits: submodules are not exported and LFS files are not expanded.

export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const noExportRules = "* -export-ignore -export-subst\n";

export class SnapshotStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  // The snapshot of `repoDir` (a clone holding `sha`) as <root>/<name>@<sha>, made if it is not there yet.
  ensure(name: string, repoDir: string, sha: string): string {
    const dir = join(this.root, `${name}@${sha}`);
    if (existsSync(dir)) {
      const now = new Date();
      utimesSync(dir, now, now); // last use, for the pruning
      return dir;
    }
    mkdirSync(this.root, { recursive: true });
    // Without this, files the repo marks export-ignore would be missing and $Format$ strings rewritten.
    const info = join(
      gitOrThrow(repoDir, ["rev-parse", "--absolute-git-dir"]),
      "info",
    );
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "attributes"), noExportRules);

    const tmp = mkdtempSync(join(this.root, ".tmp-"));
    try {
      const tarball = join(tmp, "snapshot.tar");
      const archive = exec(
        "git",
        ["archive", "--format=tar", "-o", tarball, sha],
        {
          cwd: repoDir,
        },
      );
      if (archive.code !== 0) {
        throw new Error(
          `git archive ${sha} failed: ${archive.out.slice(0, 400)}`,
        );
      }
      const tree = join(tmp, "tree");
      mkdirSync(tree);
      const unpack = exec("tar", ["-xf", tarball, "-C", tree]);
      if (unpack.code !== 0) {
        throw new Error(
          `tar of ${name}@${sha} failed: ${unpack.out.slice(0, 400)}`,
        );
      }
      try {
        renameSync(tree, dir);
      } catch (error) {
        // someone else made the same snapshot in the meantime: theirs is as good as ours
        if (!existsSync(dir)) throw error;
      }
      return dir;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// Removes the snapshots that have not been used for `maxAgeMs`, and leftovers of exports that never finished.
// Returns what it removed.
export function pruneSnapshots(
  root: string,
  maxAgeMs: number = SNAPSHOT_MAX_AGE_MS,
  now: number = Date.now(),
): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
