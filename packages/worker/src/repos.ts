import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitOrThrow, hasRef } from "@afk/pipeline";

// The worker's main clones, one per repo, kept bare: they hold the branches every slot clone starts from.
// They follow origin for the default branch and the integration branches; ticket branches only move forward.

export class RepoStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dirFor(role: string): string {
    return join(this.root, `${role}.git`);
  }

  // Clones on first use, then brings the branches the pipeline cares about up to date.
  ensure(role: string, url: string, defaultBranch: string): string {
    const dir = this.dirFor(role);
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      gitOrThrow(this.root, ["clone", "--quiet", "--bare", url, dir]);
    }
    // '+' for the branches origin owns; a failure here means the default branch or the integration branch is
    // stale, so it is an error, not something to carry on with.
    gitOrThrow(dir, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
      "+refs/heads/spec/*:refs/heads/spec/*",
    ]);
    // Ticket branches only move forward and can hold work origin has not seen: a refused update is fine.
    git(dir, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      "refs/heads/agent/*:refs/heads/agent/*",
    ]);
    return dir;
  }

  has(dir: string, ref: string): boolean {
    return hasRef(dir, ref);
  }
}
