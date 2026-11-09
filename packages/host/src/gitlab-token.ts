import { readFileSync, statSync } from "node:fs";
import type { TokenSource } from "./types.ts";

// A GitLab PAT lives in one file (~/.afk/secrets/gitlab/<host>, mode 600). It is read on every
// tokenFor so replacing the file is enough; TokenPermissions are ignored (the user's role is what
// the PAT can do).

export function createGitLabTokenSource(options: {
  path: string;
}): TokenSource {
  return {
    async tokenFor() {
      if (statSync(options.path).mode & 0o077)
        throw new Error(
          `${options.path} must only be readable by you: chmod 600 it`,
        );
      const token = readFileSync(options.path, "utf8").trim();
      if (!token) throw new Error(`${options.path} is empty`);
      return token;
    },
  };
}
