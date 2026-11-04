// Rewrites packages/shared/skills-snapshot/ and the planning skills under skills/ from a mattpocock/skills checkout,
// at SKILLS_SHA:
//   node scripts/refresh-skills-snapshot.ts <path to a skills checkout>
// Each file is taken from the commit (not the working tree). Snapshot files get a header naming the SHA; the planning
// skills are copied unchanged, with the upstream LICENSE, so they install as they are. Run it after changing
// SKILLS_SHA, then read the diff (see "Upgrading the skills SHA" in docs/operations-manual.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_SHA } from "../packages/shared/src/skills-sha.ts";
import {
  PLANNING_SKILLS,
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

const git = (...args: string[]) =>
  execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
const show = (path: string) => git("show", `${SKILLS_SHA}:${path}`);
const write = (target: string, content: string) => {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

for (const file of SNAPSHOT_FILES) {
  write(
    `${SNAPSHOT_DIR}${file}`,
    snapshotHeader(SKILLS_SHA, file) + show(`skills/engineering/${file}`),
  );
}

const skillsDir = fileURLToPath(new URL("../skills/", import.meta.url));
const license = show("LICENSE");
for (const [name, path] of Object.entries(PLANNING_SKILLS)) {
  rmSync(`${skillsDir}${name}`, { recursive: true, force: true });
  const files = git("ls-tree", "-r", "--name-only", SKILLS_SHA, `${path}/`)
    .trim()
    .split("\n");
  for (const file of files) {
    write(`${skillsDir}${name}/${file.slice(path.length + 1)}`, show(file));
  }
  write(`${skillsDir}${name}/LICENSE`, license);
}
write(
  `${skillsDir}VENDORED.md`,
  [
    "# Skills copied from mattpocock/skills",
    "",
    `${Object.keys(PLANNING_SKILLS).join(", ")}: copied unchanged from https://github.com/mattpocock/skills at ${SKILLS_SHA}, under its MIT license (the LICENSE file in each). Written by scripts/refresh-skills-snapshot.ts; edit them upstream, not here.`,
    "",
  ].join("\n"),
);

console.log(
  `Snapshot of ${SNAPSHOT_FILES.length} files and ${Object.keys(PLANNING_SKILLS).length} planning skills at ${SKILLS_SHA}`,
);
