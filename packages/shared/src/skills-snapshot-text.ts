import { readFileSync } from "node:fs";

// A file of this repo, by its path from the repo root. A module of its own so that the plat the platform hands out
// (packages/api/src/cli/cli-bundle.ts) can carry the files it reads inside it instead of reading the disk.
export const readRepoText = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
