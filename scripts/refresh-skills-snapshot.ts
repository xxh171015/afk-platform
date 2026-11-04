// Rewrites everything the platform takes from mattpocock/skills, from a checkout of it, at SKILLS_SHA:
//   node scripts/refresh-skills-snapshot.ts <path to a skills checkout>
// Each file is taken from the commit (not the working tree) and copied unchanged: the planning skills under skills/,
// the sandbox skills under packages/pipeline/skills/ (each with the upstream LICENSE, so they install and mount as
// they are), the seed templates under packages/shared/skills-snapshot/. Each folder's VENDORED.md names the SHA. Run
// it after changing SKILLS_SHA, then read the diff (see "升级 skills SHA" in docs/operations-manual.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_SHA } from "../packages/shared/src/skills-sha.ts";
import {
  PLANNING_SKILLS,
  SANDBOX_SKILLS,
  TEMPLATE_FILES,
} from "../packages/shared/src/skills-snapshot.ts";

const checkout = process.argv[2];
if (!checkout) {
  console.error(
    "usage: node scripts/refresh-skills-snapshot.ts <path to a mattpocock/skills checkout>",
  );
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
const show = (path: string) => git("show", `${SKILLS_SHA}:${path}`);
const write = (path: string, content: string) => {
  mkdirSync(dirname(`${root}${path}`), { recursive: true });
  writeFileSync(`${root}${path}`, content);
};
const note = (dir: string, what: string) =>
  write(
    `${dir}/VENDORED.md`,
    [
      "# Copied from mattpocock/skills",
      "",
      `${what}: copied unchanged from https://github.com/mattpocock/skills at ${SKILLS_SHA}, under its MIT license. Written by scripts/refresh-skills-snapshot.ts; change them upstream, not here.`,
      "",
    ].join("\n"),
  );

const license = show("LICENSE");
const copySkills = (dir: string, skills: Record<string, string>) => {
  for (const [name, path] of Object.entries(skills)) {
    rmSync(`${root}${dir}/${name}`, { recursive: true, force: true });
    const files = git("ls-tree", "-r", "--name-only", SKILLS_SHA, `${path}/`)
      .trim()
      .split("\n");
    for (const file of files) {
      write(`${dir}/${name}/${file.slice(path.length + 1)}`, show(file));
    }
    write(`${dir}/${name}/LICENSE`, license);
  }
  note(dir, Object.keys(skills).join(", "));
};

copySkills("skills", PLANNING_SKILLS);
copySkills("packages/pipeline/skills", SANDBOX_SKILLS);

const templates = "packages/shared/skills-snapshot";
rmSync(`${root}${templates}`, { recursive: true, force: true });
for (const file of TEMPLATE_FILES) {
  write(`${templates}/${file}`, show(`skills/engineering/${file}`));
}
write(`${templates}/LICENSE`, license);
note(templates, TEMPLATE_FILES.join(", "));

console.log(
  `${Object.keys(PLANNING_SKILLS).length} planning skills, ${Object.keys(SANDBOX_SKILLS).length} sandbox skills and ${TEMPLATE_FILES.length} templates at ${SKILLS_SHA}`,
);
