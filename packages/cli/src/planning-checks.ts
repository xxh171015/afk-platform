import { repoHtmlUrl } from "@afk/shared";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { readAfkSetupSkill } from "./afk-setup-text.ts";
import {
  renderTrackerDoc,
  type TrackerDocProject,
  trackerDocTarget,
} from "./tracker-doc.ts";

// What `plat spec create` and `plat tickets import` check about the planning machine before they publish. Both only
// ever warn: a failed look is no reason to fail the command (docs/specs/m1-platform.md「plat CLI」).

type ReadFile = (path: string) => Promise<string>;

const DOC_PATH = "docs/agents/issue-tracker.md";

// The skills directories of the agents that run the planning skills, in the planning repo (project level) and in the
// home directory (user level). `npx skills` installs into .agents/skills and links the others.
const SKILLS_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills"];
const PLANNING_SKILLS = ["to-spec", "to-tickets"] as const;
// One package holds afk-setup and the planning skills at the pinned SHA (skills/). The first install is like
// `npx skills@latest add mattpocock/skills`: it asks which skills, which agents, project or global. `plat update`
// installs it again at the level it is at.
const SKILLS_INSTALL = "npx skills@latest add xxh171015/afk-platform";
export type SkillsLevel = "project" | "user";
const skillsFix = (level: SkillsLevel | undefined) =>
  level === undefined
    ? `install them: ${SKILLS_INSTALL}`
    : `update them: plat update${level === "project" ? " (in this repo)" : ""}`;

/** The command `plat update` runs to install the skills package again at `level`. */
export const skillsUpdateCommand = (level: SkillsLevel): string[] => [
  "npx",
  "-y",
  "skills@latest",
  "add",
  "xxh171015/afk-platform",
  "--skill",
  "*",
  ...(level === "user" ? ["-g"] : []),
  "-y",
];

/**
 * Where the afk-setup skill is installed: in the repo `repo` (project level, what the agent there uses), or for the
 * user; undefined when nowhere.
 */
export async function skillsLevel(
  readFile: ReadFile,
  home: string,
  repo = ".",
): Promise<SkillsLevel | undefined> {
  for (const [level, root] of [
    ["project", repo],
    ["user", home],
  ] as const) {
    for (const dir of SKILLS_DIRS) {
      try {
        await readFile(`${root}/${dir}/afk-setup/SKILL.md`);
        return level;
      } catch {}
    }
  }
  return undefined;
}

// Setting a repo up, and bringing its tracker doc up to date, is the afk-setup skill's job (skills/afk-setup). The
// planning agent reads these warnings and runs it itself: the person types nothing.
const SETUP = "run the afk-setup skill";

/**
 * Warnings about the planning repo's tracker doc: it is compared whole with what `plat tracker-doc` prints now, so a
 * new template, a changed project and a hand edit are all found. `project` is the one the command was asked about, if
 * it was; otherwise the project comes from the document's own version line.
 */
export async function trackerDocWarnings(
  readFile: ReadFile,
  loadProject: (id: number) => Promise<TrackerDocProject>,
  project: number | undefined,
): Promise<string[]> {
  let doc: string;
  try {
    doc = await readFile(DOC_PATH);
  } catch {
    return [
      `warning: this repo is not set up for the platform (no ${DOC_PATH}): ${SETUP}`,
    ];
  }
  const target = trackerDocTarget(doc);
  if (!target) {
    return [
      `warning: ${DOC_PATH} has no version line naming its project and repo (the platform did not write it): ${SETUP} to replace it`,
    ];
  }
  const projectId = project ?? target.project;
  let current: string;
  try {
    current = renderTrackerDoc(await loadProject(projectId), target.repo);
  } catch {
    return [
      `warning: could not compare ${DOC_PATH} with what the platform generates for project ${projectId} (is the platform reachable?); if unsure, ${SETUP} again`,
    ];
  }
  return current === doc
    ? []
    : [
        `warning: ${DOC_PATH} is out of date (the template, the project settings or the file itself changed): ${SETUP} again`,
      ];
}

/**
 * Warnings about the planning machine's skills: to-spec and to-tickets must be the snapshot's text byte for byte (the
 * pinned SHA), and afk-setup the one this platform carries. A skill installed in the planning repo
 * (`repo`, project level) is the one the agent uses, so it is judged alone; otherwise the user's.
 */
export async function skillsWarnings(
  readFile: ReadFile,
  home: string,
  repo = ".",
): Promise<string[]> {
  const warnings: string[] = [];
  const wanted = [
    ...PLANNING_SKILLS.map((skill) => ({
      skill,
      expected: readSkillSnapshot(`${skill}/SKILL.md`),
    })),
    { skill: "afk-setup", expected: readAfkSetupSkill() },
  ];
  const levels: [SkillsLevel, string][] = [
    ["project", repo],
    ["user", home],
  ];
  for (const { skill, expected } of wanted) {
    let verdict: { level: SkillsLevel; ok: boolean } | undefined;
    for (const [level, root] of levels) {
      // Any of the level's directories holding the expected text is enough.
      const copies: string[] = [];
      for (const dir of SKILLS_DIRS) {
        try {
          copies.push(await readFile(`${root}/${dir}/${skill}/SKILL.md`));
        } catch {}
      }
      if (copies.length > 0) {
        verdict = { level, ok: copies.includes(expected) };
        break;
      }
    }
    if (verdict?.ok) continue;
    const where = (level: SkillsLevel) =>
      level === "project" ? "in this repo" : "on this machine";
    warnings.push(
      verdict
        ? `warning: the ${skill} skill ${where(verdict.level)} is not the version this platform uses: ${skillsFix(verdict.level)}`
        : `warning: the ${skill} skill was not found in this repo or under ${SKILLS_DIRS.map((d) => `~/${d}`).join(", ")}: ${skillsFix(undefined)}`,
    );
  }
  return warnings;
}

/** A warning when this plat is older or newer than the platform it talks to. */
export async function versionWarnings(
  loadVersion: () => Promise<{ platformVersion: string }>,
): Promise<string[]> {
  const { platformVersion } = await loadVersion();
  return platformVersion === PLATFORM_VERSION
    ? []
    : [
        `warning: this plat is from platform ${PLATFORM_VERSION}, the platform is ${platformVersion}: update it with plat update`,
      ];
}

// What the last check of a repo found (GET /projects/{id}/repos/{name}/access): `files` comes with a definite answer
// about a GitHub repo the App can work on, and only such an answer is acted on.
export interface RepoAccessView {
  state: string;
  files?: { gates: boolean; integrationCompose: boolean };
}

const GATES_PATH = ".sandcastle/gates.yaml";
const COMPOSE_PATH = ".sandcastle/integration/compose.yaml";

/**
 * Why a spec cannot start yet (`plat spec confirm`): a repo it has tickets in has no gates.yaml on its default
 * branch, so every one of its tickets would fail at the gate. A repo set up by the afk-setup skill gets one through
 * its afk/setup pull request, which a person merges.
 */
export function unreadyRepos(
  repos: { name: string; url: string; access: RepoAccessView | undefined }[],
): string[] {
  return repos
    .filter((repo) => repo.access?.files?.gates === false)
    .map((repo) => {
      const html = repoHtmlUrl(repo.url);
      const where = html ? ` (${html}/pulls?q=is%3Apr+head%3Aafk%2Fsetup)` : "";
      return `${repo.name} has no ${GATES_PATH} on its default branch, so its tickets cannot pass a gate: merge its setup pull request${where}, then confirm again`;
    });
}

/**
 * Warnings for `plat tickets import`: an integration ticket starts the repos in its `environment` from their
 * compose files, which the spec itself can add (the environment is built from the spec's integration branches). It
 * is worth a word when a repo has none on its default branch and no ticket file here in that repo mentions it.
 */
export function integrationWarnings(
  tickets: {
    displayId: string;
    type: string;
    repo: string;
    environment: string[];
  }[],
  files: { name: string; text: string }[],
  access: Map<string, RepoAccessView | undefined>,
): string[] {
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const addedIn = (repo: string) => {
    const inRepo = new RegExp(`^repo:\\s*["']?${escaped(repo)}["']?\\s*$`, "m");
    return files.some(
      (file) => inRepo.test(file.text) && file.text.includes(COMPOSE_PATH),
    );
  };
  const warnings: string[] = [];
  for (const ticket of tickets) {
    if (ticket.type !== "integration") continue;
    for (const repo of ticket.environment) {
      if (access.get(repo)?.files?.integrationCompose !== false) continue;
      if (addedIn(repo)) continue;
      warnings.push(
        `${ticket.displayId} runs its e2e against ${repo}, which has no ${COMPOSE_PATH} on its default branch, and no ticket here in ${repo} adds it: add one (see "Integration tickets" in docs/agents/issue-tracker.md)`,
      );
    }
  }
  return warnings;
}
