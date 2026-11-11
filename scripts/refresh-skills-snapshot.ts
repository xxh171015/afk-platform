// Rewrites everything the platform takes from mattpocock/skills, from a checkout of it, at SKILLS_SHA:
//   node scripts/refresh-skills-snapshot.ts <path to a skills checkout>
// Each file is taken from the commit (not the working tree) and copied unchanged, except SETUP_SKILL_RENAMED below:
// the planning skills under skills/, the sandbox skills under packages/pipeline/skills/ (each with the upstream
// LICENSE, so they install and mount as they are), the seed templates under packages/shared/skills-snapshot/. Each
// folder's VENDORED.md names the SHA and the sha256 of every file copied there, so a hand edit (or an editor's
// formatter) fails packages/shared/src/skills-snapshot.test.ts. Run it after changing SKILLS_SHA, then read the diff
// (see "升级 skills SHA" in docs/operations-manual.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// What was copied into each folder, by path in it, with its sha256.
const copied = new Map<string, string[]>();
const copy = (dir: string, path: string, content: string) => {
  write(`${dir}/${path}`, content);
  const hash = createHash("sha256").update(content).digest("hex");
  copied.set(dir, [...(copied.get(dir) ?? []), `${hash}  ${path}`]);
};
const note = (dir: string, what: string) =>
  write(
    `${dir}/VENDORED.md`,
    [
      "# Copied from mattpocock/skills",
      "",
      `${what}: copied unchanged from https://github.com/mattpocock/skills at ${SKILLS_SHA}, under its MIT license. Written by scripts/refresh-skills-snapshot.ts; change them upstream, not here: platform rules go in files the platform owns (the tracker-doc templates, the planning conventions plat init writes, AGENTS.md).`,
      "",
      "## Files (sha256)",
      "",
      "```",
      ...(copied.get(dir) ?? []).sort((a, b) =>
        a.slice(66).localeCompare(b.slice(66)),
      ),
      "```",
      "",
    ].join("\n"),
  );

// The one change made to a copy: on a planning machine the tracker doc comes from /afk-setup, so to-spec and
// to-tickets name it instead of /setup-matt-pocock-skills (held by packages/cli/src/afk-setup-text.test.ts).
const SETUP_SKILL_RENAMED = ["to-spec/SKILL.md", "to-tickets/SKILL.md"];
const renameSetupSkill = (text: string) =>
  text.replaceAll("/setup-matt-pocock-skills", "/afk-setup");

const license = show("LICENSE");
const copySkills = (
  dir: string,
  skills: Record<string, string>,
  what: string,
  rewrite: (file: string, text: string) => string = (_, text) => text,
) => {
  for (const [name, path] of Object.entries(skills)) {
    rmSync(`${root}${dir}/${name}`, { recursive: true, force: true });
    const files = git("ls-tree", "-r", "--name-only", SKILLS_SHA, `${path}/`)
      .trim()
      .split("\n");
    for (const file of files) {
      const into = `${name}/${file.slice(path.length + 1)}`;
      copy(dir, into, rewrite(into, show(file)));
    }
    copy(dir, `${name}/LICENSE`, license);
  }
  note(dir, what);
};

copySkills(
  "skills",
  PLANNING_SKILLS,
  `${Object.keys(PLANNING_SKILLS).join(", ")} (except that ${SETUP_SKILL_RENAMED.join(" and ")} say /afk-setup where upstream says /setup-matt-pocock-skills)`,
  (file, text) =>
    SETUP_SKILL_RENAMED.includes(file) ? renameSetupSkill(text) : text,
);
copySkills(
  "packages/pipeline/skills",
  SANDBOX_SKILLS,
  Object.keys(SANDBOX_SKILLS).join(", "),
);

const templates = "packages/shared/skills-snapshot";
rmSync(`${root}${templates}`, { recursive: true, force: true });
for (const file of TEMPLATE_FILES) {
  copy(templates, file, show(`skills/engineering/${file}`));
}
copy(templates, "LICENSE", license);
note(templates, TEMPLATE_FILES.join(", "));

console.log(
  `${Object.keys(PLANNING_SKILLS).length} planning skills, ${Object.keys(SANDBOX_SKILLS).length} sandbox skills and ${TEMPLATE_FILES.length} templates at ${SKILLS_SHA}`,
);
