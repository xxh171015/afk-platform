import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PLANNING_SKILLS } from "@afk/shared/skills-snapshot";
import { expectedSkillText, SKILLS_DIRS } from "./planning-checks.ts";

// Where `plat update` (and afk-setup through it) installs afk-setup and the planning skills, at the platform's
// commit of xxh171015/afk-platform. Only the person picks the user level: the skills follow afk-setup, and the
// planning skills never replace ones the person has for themselves (other projects use those). At project level the
// skills stay on this machine: their files and skills-lock.json go to the repo's .git/info/exclude.

const PACKAGE = "xxh171015/afk-platform";
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

/** The skills CLI command that installs `skills` ("*" for the whole package) at `commit`, for the user or here. */
export const skillsInstallCommand = (
  commit: string | null,
  skills: "*" | string[],
  user: boolean,
): string[] => [
  "npx",
  "-y",
  "skills@latest",
  "add",
  commit ? `${PACKAGE}#${commit}` : PACKAGE,
  ...(skills === "*"
    ? ["--skill", "*"]
    : skills.flatMap((s) => ["--skill", s])),
  ...(user ? ["-g"] : []),
  "-y",
];

const skillAt = (root: string, skill: string): string | undefined => {
  for (const dir of SKILLS_DIRS) {
    const file = join(root, dir, skill, "SKILL.md");
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
};

// The planning skills the person installed for themselves from the platform, as the skills CLI's lock says.
function platformSkillsForUser(home: string): string[] {
  let lock: unknown;
  try {
    lock = JSON.parse(
      readFileSync(join(home, ".agents/.skill-lock.json"), "utf8"),
    );
  } catch {
    return [];
  }
  const entries =
    (lock as { skills?: Record<string, unknown> })?.skills ?? lock;
  if (!entries || typeof entries !== "object") return [];
  return PLANNING_SKILL_NAMES.filter((skill) =>
    JSON.stringify((entries as Record<string, unknown>)[skill] ?? "").includes(
      PACKAGE,
    ),
  );
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, out: result.stdout ?? "" };
}

// The skills of the package installed in this repo and not tracked, with skills-lock.json when it is not tracked,
// added to .git/info/exclude where missing. Returns the lines added.
export function excludeProjectSkills(repo: string): string[] {
  const names = ALL_SKILLS.join("|");
  const skill = new RegExp(`^((?:[^/]+/)*skills/(?:${names}))(?:/|$)`);
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
    if (match) paths.add(`/${match[1]}`);
    if (file === LOCK) paths.add(`/${LOCK}`);
  }
  if (paths.size === 0) return [];
  const where = git(repo, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]).out.trim();
  const exclude = isAbsolute(where) ? where : join(repo, where);
  const have = existsSync(exclude)
    ? new Set(readFileSync(exclude, "utf8").split("\n"))
    : new Set<string>();
  const missing = [...paths].sort().filter((line) => !have.has(line));
  if (missing.length > 0) {
    mkdirSync(dirname(exclude), { recursive: true });
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    appendFileSync(
      exclude,
      `${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }
  return missing;
}

export interface SkillsUpdate {
  home: string;
  repo: string | undefined; // the git checkout plat runs in, if any
  commit: string | null; // the platform's commit; null installs the package's latest
  run: RunCommand;
}

/** Installs the skills again at the levels afk-setup is at; the lines that say what it did. Throws on a failed install. */
export function updateSkills({
  home,
  repo,
  commit,
  run,
}: SkillsUpdate): string[] {
  const here = repo !== undefined && skillAt(repo, "afk-setup") !== undefined;
  const forUser = skillAt(home, "afk-setup") !== undefined;
  if (!here && !forUser)
    return [
      `skills: afk-setup is not installed here or for you; install them once with: npx skills@latest add ${PACKAGE}${commit ? `#${commit}` : ""}`,
    ];
  const lines: string[] = [];
  if (!commit)
    lines.push(
      "skills: the platform does not say which commit it runs, so the package's latest is installed",
    );
  const install = (skills: "*" | string[], user: boolean, cwd: string) => {
    const [command, ...args] = skillsInstallCommand(commit, skills, user);
    const done = run(command as string, args, cwd);
    if (done.code !== 0)
      throw new Error(
        `skills: ${[command, ...args].join(" ")} failed${done.error ? ` (${done.error})` : ""}`,
      );
  };
  // In this repo: the whole package, over the copies that are not the platform's.
  const installHere = (skills: "*" | string[]) => {
    const root = repo as string;
    const named = skills === "*" ? ALL_SKILLS : skills;
    const replaced = named.filter((skill) => {
      const text = skillAt(root, skill);
      const expected = expectedSkillText(skill);
      return text !== undefined && expected !== undefined && text !== expected;
    });
    install(skills, false, root);
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
  if (forUser) {
    const fromPlatform = platformSkillsForUser(home);
    const theirs = PLANNING_SKILL_NAMES.filter(
      (skill) =>
        !fromPlatform.includes(skill) && skillAt(home, skill) !== undefined,
    );
    if (fromPlatform.length > 0)
      lines.push(
        `skills: ${fromPlatform.join(", ")} for you come from the platform, so every project of yours plans with them; plat leaves them; to go back to Matt's: npx skills@latest add mattpocock/skills -g`,
      );
    if (fromPlatform.length === 0 && theirs.length === 0) {
      install("*", true, home);
      lines.push("skills: afk-setup and the planning skills installed for you");
    } else {
      install(["afk-setup"], true, home);
      lines.push("skills: afk-setup installed for you");
      if (here) {
        // the planning skills are in this repo already
      } else if (repo !== undefined) {
        installHere(PLANNING_SKILL_NAMES);
      } else {
        lines.push(
          "skills: you have planning skills of your own, so the platform's go into the planning repo: run plat update there",
        );
      }
    }
  }
  return lines;
}
