import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { SKILLS_PACKAGE } from "@afk/shared";
import { excludeLocally } from "./git-exclude.ts";
import { readSkillsPackage } from "./skills-package-text.ts";

// Where `plat sync` and `plat update` (and afk-setup through them) put afk-setup and the planning skills: in the
// planning repo only, on this machine only, written from the copy plat carries (skills-package-text.ts). Nothing is
// fetched from GitHub and nothing goes to the user's own skills directories. The layout is the one
// `npx skills add -a cursor -a claude-code` makes: the files under .agents/skills/<name> (Cursor reads it), and
// .claude/skills/<name> a link to it (Claude Code). The paths go to the repo's .git/info/exclude.

const FILES_DIR = ".agents/skills";
const LINK_DIRS = [".claude/skills", ".cursor/skills"];

/** The skills of the package plat carries, afk-setup first. */
export function packageSkills(): string[] {
  const names = new Set(
    Object.keys(readSkillsPackage()).map((path) => path.split("/")[0] ?? ""),
  );
  names.delete("afk-setup");
  return ["afk-setup", ...[...names].sort()];
}

/** The files of one skill as the platform has it, by path inside the skill's folder. */
export function packageSkillFiles(skill: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(readSkillsPackage()))
    if (path.startsWith(`${skill}/`))
      files[path.slice(skill.length + 1)] = text;
  return files;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, out: result.stdout ?? "" };
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const isThere = (path: string) => isLink(path) || existsSync(path);

// The regular files under `dir`, by path inside it; undefined when `dir` is not a real directory.
function filesIn(dir: string): Record<string, string> | undefined {
  if (isLink(dir) || !existsSync(dir)) return undefined;
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        files[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

const sameFiles = (
  a: Record<string, string> | undefined,
  b: Record<string, string>,
) =>
  a !== undefined &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([path, text]) => a[path] === text);

const linkTarget = (skill: string) => `../../${FILES_DIR}/${skill}`;

// The SKILL.md of a copy of `skill` in this repo, wherever an agent finds one.
function skillText(repo: string, skill: string): string | undefined {
  for (const dir of [FILES_DIR, ...LINK_DIRS]) {
    const file = join(repo, dir, skill, "SKILL.md");
    try {
      return readFileSync(file, "utf8");
    } catch {}
  }
  return undefined;
}

// Writes one skill: its files under .agents/skills, a link from .claude/skills, and from .cursor/skills when an
// earlier install made one there. True when anything changed.
function writeSkill(repo: string, skill: string): boolean {
  const wanted = packageSkillFiles(skill);
  const filesDir = join(repo, FILES_DIR, skill);
  let changed = false;
  if (!sameFiles(filesIn(filesDir), wanted)) {
    rmSync(filesDir, { recursive: true, force: true });
    for (const [path, text] of Object.entries(wanted)) {
      const file = join(filesDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    changed = true;
  }
  for (const dir of LINK_DIRS) {
    const link = join(repo, dir, skill);
    if (dir !== ".claude/skills" && !isThere(link)) continue;
    if (isLink(link) && readlinkSync(link) === linkTarget(skill)) continue;
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(linkTarget(skill), link);
    changed = true;
  }
  return changed;
}

// Skills of the package's names in this repo's agent directories (.agents/skills, .claude/skills, .windsurf/skills,
// …) that git does not track, added to .git/info/exclude where missing; returns the lines added.
export function excludeProjectSkills(repo: string): string[] {
  const names = packageSkills().join("|");
  const skill = new RegExp(`^((?:\\.[^/]+/)+skills/(?:${names}))(?:/|$)`);
  const paths = new Set<string>();
  for (const file of git(repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .out.split("\0")
    .filter(Boolean)) {
    const match = skill.exec(file);
    if (match?.[1]) paths.add(match[1]);
  }
  // sorted, so the lines come in the same order every time
  return excludeLocally(repo, [...paths].sort());
}

// Where the user's skills CLI lock says each skill came from: ~/.agents/.skill-lock.json, whose entries carry a
// `source` such as mattpocock/skills (seen on a real machine, #171).
function userLockSources(home: string): Record<string, string> {
  let lock: unknown;
  try {
    lock = JSON.parse(
      readFileSync(join(home, ".agents/.skill-lock.json"), "utf8"),
    );
  } catch {
    return {};
  }
  const skills = ((lock as { skills?: unknown })?.skills ?? lock) as Record<
    string,
    unknown
  > | null;
  const sources: Record<string, string> = {};
  for (const [name, entry] of Object.entries(skills ?? {})) {
    const source = (entry as { source?: unknown } | null)?.source;
    if (typeof source === "string") sources[name] = source;
  }
  return sources;
}

export interface SkillsInstall {
  home: string;
  repo: string | undefined; // the git checkout plat runs in, if any
  // Only bring up skills that are in this repo already (after plat replaced itself, whatever the command and the
  // repo); otherwise write them all (`plat sync`, `plat update`).
  onlyWhereInstalled?: boolean;
}

/** Writes afk-setup and the planning skills into the planning repo; the lines that say what it did. */
export function installSkills({
  home,
  repo,
  onlyWhereInstalled = false,
}: SkillsInstall): string[] {
  const skills = packageSkills();
  const lines: string[] = [];
  if (repo === undefined) {
    lines.push(
      "skills: this is not a git checkout; run plat sync in the planning repo to put the skills there",
    );
  } else if (
    onlyWhereInstalled &&
    !skills.some((skill) => skillText(repo, skill) !== undefined)
  ) {
    lines.push("skills: none in this repo");
  } else {
    // A copy git tracks is the repo's own: plat does not write over it.
    const tracked = skills.filter(
      (skill) =>
        git(repo, [
          "ls-files",
          "--",
          ...[FILES_DIR, ...LINK_DIRS].map((dir) => `${dir}/${skill}`),
        ]).out.trim() !== "",
    );
    const replaced: string[] = [];
    let changed = false;
    for (const skill of skills) {
      if (tracked.includes(skill)) continue;
      const before = skillText(repo, skill);
      if (!writeSkill(repo, skill)) continue;
      changed = true;
      if (
        before !== undefined &&
        before !== packageSkillFiles(skill)["SKILL.md"]
      )
        replaced.push(skill);
    }
    excludeProjectSkills(repo);
    if (!changed) lines.push("skills: the platform's, up to date in this repo");
    else if (replaced.length === 0)
      lines.push(
        "skills: afk-setup and the planning skills written in this repo, on this machine only (in .git/info/exclude)",
      );
    else
      lines.push(
        `skills: replaced in this repo with the platform's: ${replaced.join(", ")}`,
      );
    if (tracked.length > 0)
      lines.push(
        `skills: git tracks ${tracked.join(", ")} in this repo, so plat left them as they are and the platform's are not there: take them out of git, then run plat sync`,
      );
  }

  // The platform's copies an older plat installed for the user: this repo's come first, so they are only named.
  const sources = userLockSources(home);
  const forUser = skills.filter(
    (skill) => sources[skill]?.split("#")[0] === SKILLS_PACKAGE,
  );
  if (forUser.length > 0)
    lines.push(
      `skills: you still have the platform's ${forUser.join(", ")} for you from an older install; the planning repo's copies come first there. To remove them: npx skills@latest remove -g -y ${forUser.join(" ")}`,
    );
  return lines;
}
