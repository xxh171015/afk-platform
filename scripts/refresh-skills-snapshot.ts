// Rewrites packages/shared/skills-snapshot/ from a mattpocock/skills checkout, at SKILLS_SHA:
//   node scripts/refresh-skills-snapshot.ts <path to a skills checkout>
// Each file is taken from the commit (not the working tree), prefixed with a header naming the SHA. Run it after
// changing SKILLS_SHA, then read the diff (see "Upgrading the skills SHA" in docs/operations-manual.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SKILLS_SHA } from "../packages/shared/src/skills-sha.ts";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_FILES,
  snapshotHeader,
} from "../packages/shared/src/skills-snapshot.ts";

const checkout = process.argv[2];
if (!checkout) {
  console.error(
    "usage: node scripts/refresh-skills-snapshot.ts <path to a mattpocock/skills checkout>",
  );
  process.exit(2);
}

for (const file of SNAPSHOT_FILES) {
  const content = execFileSync(
    "git",
    ["-C", checkout, "show", `${SKILLS_SHA}:skills/engineering/${file}`],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const target = `${SNAPSHOT_DIR}${file}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, snapshotHeader(SKILLS_SHA, file) + content);
}
console.log(`Snapshot of ${SNAPSHOT_FILES.length} files at ${SKILLS_SHA}`);
