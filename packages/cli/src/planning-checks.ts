import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import {
  renderTrackerDoc,
  type TrackerDocProject,
  trackerDocTarget,
} from "./tracker-doc.ts";

// What `plat spec create` and `plat tickets import` check about the planning machine before they publish. Both only
// ever warn: a failed look is no reason to fail the command (docs/specs/m1-platform.md「plat CLI」).

type ReadFile = (path: string) => Promise<string>;

const DOC_PATH = "docs/agents/issue-tracker.md";

// The user-level skills directories of the agents that run to-spec and to-tickets; the first that has the skill wins.
const SKILLS_DIRS = [".claude/skills", ".cursor/skills", ".agents/skills"];
const PLANNING_SKILLS = ["to-spec", "to-tickets"] as const;

const updateCommand = (project: number | string, repo: string) =>
  `plat tracker-doc --project ${project} --repo ${repo} > ${DOC_PATH}`;

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
      `warning: ${DOC_PATH} does not exist; skills will not know how to use the platform. Generate it: ${updateCommand(project ?? "<id>", "<name>")}`,
    ];
  }
  const target = trackerDocTarget(doc);
  if (!target) {
    return [
      `warning: ${DOC_PATH} has no version line naming its project and repo (it was not made by this version of plat tracker-doc). Replace it: ${updateCommand(project ?? "<id>", "<name>")}`,
    ];
  }
  const projectId = project ?? target.project;
  let current: string;
  try {
    current = renderTrackerDoc(await loadProject(projectId), target.repo);
  } catch {
    return [
      `warning: could not compare ${DOC_PATH} with what plat tracker-doc prints for project ${projectId} (is the platform reachable?); regenerate it if unsure: ${updateCommand(projectId, target.repo)}`,
    ];
  }
  return current === doc
    ? []
    : [
        `warning: ${DOC_PATH} is out of date (the template, the project settings or the file itself changed). Regenerate it and commit: ${updateCommand(projectId, target.repo)}`,
      ];
}

/** Warnings about the planning machine's to-spec and to-tickets, which must be the snapshot's text byte for byte. */
export async function skillsWarnings(
  readFile: ReadFile,
  home: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const skill of PLANNING_SKILLS) {
    const expected = readSkillSnapshot(`${skill}/SKILL.md`).content;
    // Any of the directories holding the pinned text is enough; otherwise say what the first copy found was.
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
      `warning: the ${skill} skill on this machine ${found === undefined ? `was not found under ${SKILLS_DIRS.map((d) => `~/${d}`).join(", ")}` : "is not the pinned version"}. Link the pinned checkout: git -C <mattpocock/skills checkout> checkout ${SKILLS_SHA} && ln -sfn <mattpocock/skills checkout>/skills/engineering/${skill} ~/${SKILLS_DIRS[0]}/${skill}`,
    );
  }
  return warnings;
}
