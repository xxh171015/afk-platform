import { readFileSync } from "node:fs";

// The raw text of a snapshot file. A module of its own so that the plat the platform hands out
// (packages/api/src/cli-bundle.ts) can carry every snapshot file inside it instead of reading the disk.
export const readSnapshotText = (file: string): string =>
  readFileSync(new URL(`../skills-snapshot/${file}`, import.meta.url), "utf8");
