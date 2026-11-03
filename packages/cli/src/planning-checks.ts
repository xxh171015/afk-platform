import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
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

// The user-level skills directories of the agents that run the planning skills; the first that has the skill wins.
// `npx skills` installs into ~/.agents/skills and links the others.
const SKILLS_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills"];
const PLANNING_SKILLS = ["to-spec", "to-tickets"] as const;
const AFK_SETUP_UPDATE =
  "npx skills@latest add xxh171015/afk-platform --skill afk-setup -g -y";

// Setting a repo up, and bringing its tracker doc up to date, is the afk-setup skill's job (skills/afk-setup).
const SETUP = "in Cursor, run /afk-setup";

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
 * Warnings about the planning machine's skills: to-spec and to-tickets must be the snapshot's text byte for byte
 * (/afk-setup installs them at the pinned SHA), and afk-setup the one this platform carries.
 */
export async function skillsWarnings(
  readFile: ReadFile,
  home: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const wanted = [
    ...PLANNING_SKILLS.map((skill) => ({
      skill,
      expected: readSkillSnapshot(`${skill}/SKILL.md`).content,
      fix: `${SETUP} (it installs the skills at the pinned SHA ${SKILLS_SHA})`,
    })),
    {
      skill: "afk-setup",
      expected: readAfkSetupSkill(),
      fix: `update it: ${AFK_SETUP_UPDATE}`,
    },
  ];
  for (const { skill, expected, fix } of wanted) {
    // Any of the directories holding the expected text is enough; otherwise say what the first copy found was.
    let found: string | undefined;
    for (const dir of SKILLS_DIRS) {
      try {
        const text = await readFile(`${home}/${dir}/${skill}/SKILL.md`);
        found ??= text;
        if (text === expected) {
          found = text;
          break;
        }
      } catch {}
    }
    if (found === expected) continue;
    warnings.push(
      `warning: the ${skill} skill on this machine ${found === undefined ? `was not found under ${SKILLS_DIRS.map((d) => `~/${d}`).join(", ")}` : "is not the version this platform uses"}: ${fix}`,
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
        `warning: this plat is from platform ${PLATFORM_VERSION}, the platform is ${platformVersion}: ${SETUP} to update it`,
      ];
}
