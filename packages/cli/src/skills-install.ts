import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_PACKAGE, skillsPackageAt } from "@afk/shared";
import { PLANNING_SKILLS } from "@afk/shared/skills-snapshot";
import { excludeLocally } from "./git-exclude.ts";
import {
  expectedSkillText,
  SKILLS_DIRS,
  type SkillsLevel,
} from "./planning-checks.ts";

// Where `plat update` (and afk-setup through it) installs afk-setup and the planning skills, at the platform's
// commit of the skills package. Only the person picks the user level: the skills follow afk-setup, and plat never
// changes what the person has for the user when planning skills of the same names are there (other projects use
// them); the planning skills then go into the planning repo. At project level the skills stay on this machine: their
// files and skills-lock.json go to the repo's .git/info/exclude.

export const PLANNING_SKILL_NAMES = Object.keys(PLANNING_SKILLS);
const ALL_SKILLS = ["afk-setup", ...PLANNING_SKILL_NAMES];
const LOCK = "skills-lock.json";

// Runs a command in `cwd`, its output on stderr; the exit code, or the reason it did not run.
export type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => { code: number; error?: string };

export const runCommand: RunCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return { code: result.status ?? -1, error: result.error?.message };
};

/** The skills CLI command that installs `skills` ("*" for the whole package) at `commit`, at `level`. */
export const skillsInstallCommand = (
  commit: string,
  skills: "*" | string[],
  level: SkillsLevel,
): string[] => [
  "npx",
  "-y",
  "skills@latest",
  "add",
  skillsPackageAt(commit),
  ...(skills === "*"
    ? ["--skill", "*"]
    : skills.flatMap((s) => ["--skill", s])),
  ...(level === "user" ? ["-g"] : []),
  "-y",
];

const skillAt = (root: string, skill: string): string | undefined => {
  for (const dir of SKILLS_DIRS) {
    const file = join(root, dir, skill, "SKILL.md");
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
};

// Where the skills CLI's lock says a skill came from: the user's ~/.agents/.skill-lock.json, a repo's
// skills-lock.json; an entry's `source` is the package, e.g. mattpocock/skills (seen on a real machine, #171).
function lockSource(file: string, skill: string): string | undefined {
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const skills = (lock as { skills?: unknown })?.skills ?? lock;
  const entry = (skills as Record<string, unknown> | null)?.[skill];
  const source = (entry as { source?: unknown } | null)?.source;
  return typeof source === "string" ? source : undefined;
}

const fromPackage = (source: string | undefined) =>
  source?.split("#")[0] === SKILLS_PACKAGE;

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, out: result.stdout ?? "" };
}

// The skills of the package installed in this repo's agent directories (.agents/skills, .claude/skills, …) and not
// tracked, with skills-lock.json when it is not tracked, added to .git/info/exclude where missing. Returns the lines
// added.
export function excludeProjectSkills(repo: string): string[] {
  const names = ALL_SKILLS.join("|");
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
    if (file === LOCK) paths.add(LOCK);
  }
  // sorted, so the lines come in the same order every time
  return excludeLocally(repo, [...paths].sort());
}

export interface SkillsUpdate {
  home: string;
  repo: string | undefined; // the git checkout plat runs in, if any
  commit: string | null; // the platform's commit; nothing is installed without it
  run: RunCommand;
}

/** Installs the skills again at the levels afk-setup is at; the lines that say what it did. Throws on a failed install. */
export function updateSkills({
  home,
  repo,
  commit,
  run,
}: SkillsUpdate): string[] {
  // this repo has skills of the package's names: they are what the agent here reads, so they are brought up too
  const here =
    repo !== undefined &&
    ALL_SKILLS.some((skill) => skillAt(repo, skill) !== undefined);
  const forUser = skillAt(home, "afk-setup") !== undefined;
  const install = (skills: string[]) =>
    `npx skills@latest add ${commit ? skillsPackageAt(commit) : SKILLS_PACKAGE} ${skills.map((s) => `--skill ${s}`).join(" ")}`;
  if (!here && !forUser)
    return [
      `skills: afk-setup is not installed here or for you; install them once with: npx skills@latest add ${commit ? skillsPackageAt(commit) : SKILLS_PACKAGE}`,
    ];
  if (!commit)
    return [
      "skills: the platform does not say which commit of the skills it runs, so none were installed; update the platform, then run plat update again",
    ];
  const lines: string[] = [];
  const runInstall = (
    skills: "*" | string[],
    level: SkillsLevel,
    cwd: string,
  ) => {
    const [command, ...args] = skillsInstallCommand(commit, skills, level);
    const done = run(command as string, args, cwd);
    if (done.code !== 0)
      throw new Error(
        `skills: ${[command, ...args].join(" ")} failed${done.error ? ` (${done.error})` : ""}`,
      );
  };
  // In this repo, over the copies that are not the platform's, which are named.
  const installHere = (skills: "*" | string[]) => {
    const root = repo as string;
    const named = skills === "*" ? ALL_SKILLS : skills;
    const replaced = named.filter((skill) => {
      const text = skillAt(root, skill);
      if (text === undefined) return false;
      const expected = expectedSkillText(skill);
      return expected !== undefined
        ? text !== expected
        : !fromPackage(lockSource(join(root, LOCK), skill));
    });
    runInstall(skills, "project", root);
    excludeProjectSkills(root);
    lines.push(
      `skills: ${skills === "*" ? "afk-setup and the planning skills" : "the planning skills"} installed in this repo, on this machine only (in .git/info/exclude)`,
    );
    if (replaced.length > 0)
      lines.push(
        `skills: replaced in this repo, as they were not the platform's: ${replaced.join(", ")}`,
      );
  };

  if (here) installHere("*");
  if (!forUser) return lines;
  const userLock = join(home, ".agents/.skill-lock.json");
  const sameNames = PLANNING_SKILL_NAMES.filter(
    (skill) => skillAt(home, skill) !== undefined,
  );
  const fromPlatform = sameNames.filter((skill) =>
    fromPackage(lockSource(userLock, skill)),
  );
  if (sameNames.length === 0) {
    runInstall("*", "user", home);
    lines.push("skills: afk-setup and the planning skills installed for you");
    return lines;
  }
  if (fromPlatform.length > 0) {
    // the platform's skills for the user: plat changes nothing for the user
    lines.push(
      `skills: ${fromPlatform.join(", ")} for you come from the platform, so every project of yours plans with them; plat leaves what you have for you. To go back to Matt's: npx skills@latest add mattpocock/skills ${fromPlatform.map((s) => `--skill ${s}`).join(" ")} -g -y`,
      `skills: afk-setup for you is left as it is; to update it yourself: ${install(["afk-setup"])} -g -y`,
    );
  } else {
    runInstall(["afk-setup"], "user", home);
    lines.push("skills: afk-setup installed for you");
  }
  // planning skills of the same names for the user stay theirs: the platform's go into this repo
  if (here) return lines;
  if (repo !== undefined) installHere(PLANNING_SKILL_NAMES);
  else
    lines.push(
      "skills: you have planning skills of your own, so the platform's go into the planning repo: run plat update there",
    );
  return lines;
}
