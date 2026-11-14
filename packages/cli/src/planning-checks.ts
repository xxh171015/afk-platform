import { SETUP_BRANCH } from "@afk/shared";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { packageSkillFiles, packageSkills } from "./skills-install.ts";
import {
  renderTrackerDoc,
  type TrackerDocProject,
  trackerDocTarget,
} from "./tracker-doc.ts";

// What `plat spec create` and `plat tickets import` check about the planning machine before they publish. Both only
// ever warn: a failed look is no reason to fail the command (docs/specs/m1-platform.md「plat CLI」).

type ReadFile = (path: string) => Promise<string>;

const DOC_PATH = "docs/agents/issue-tracker.md";

// The skills directories an agent reads in the planning repo. plat writes the files under .agents/skills and links
// .claude/skills to them (skills-install.ts); an older install may have put copies under .cursor/skills.
export const SKILLS_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
];

// Setting a repo up, and bringing its tracker doc up to date, is the afk-setup skill's job (skills/afk-setup). The
// planning agent reads these warnings and runs it itself: the person types nothing.
const SETUP = "run the afk-setup skill";
// What brings the planning repo's skills to the platform's.
const SKILLS_FIX = "plat sync (in the planning repo)";

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
 * Warnings about the planning repo's skills: afk-setup and each planning skill must be in this repo, with the SKILL.md
 * plat carries byte for byte. Skills only the user has do not count: the platform's go in the planning repo. Two lines
 * at most: the ones missing and the ones that differ.
 */
export async function skillsWarnings(
  readFile: ReadFile,
  repo = ".",
): Promise<string[]> {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const skill of packageSkills()) {
    const expected = packageSkillFiles(skill)["SKILL.md"];
    const copies: string[] = [];
    for (const dir of SKILLS_DIRS) {
      try {
        copies.push(await readFile(`${repo}/${dir}/${skill}/SKILL.md`));
      } catch {}
    }
    if (copies.length === 0) missing.push(skill);
    else if (!copies.includes(expected as string)) stale.push(skill);
  }
  const warnings: string[] = [];
  if (missing.length > 0)
    warnings.push(
      `warning: ${missing.join(", ")} not found in this repo: put the platform's skills here with ${SKILLS_FIX}`,
    );
  if (stale.length > 0)
    warnings.push(
      `warning: ${stale.join(", ")} in this repo not the version this platform uses: bring them up with ${SKILLS_FIX} (a copy git tracks is left as it is: take it out of git first)`,
    );
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
  username?: string;
  fix?: string;
  hostKind?: string;
  message?: string;
}

const GATES_PATH = ".sandcastle/gates.yaml";
const COMPOSE_PATH = ".sandcastle/integration/compose.yaml";

/**
 * Why a spec cannot start yet (`plat spec confirm`): a repo it has tickets in has no gates.yaml on its default
 * branch nor on afk/setup, so every one of its tickets would fail at the gate. The afk-setup skill pushes one to
 * afk/setup, and the spec's integration branch starts with it (ADR 0006).
 */
export function unreadyRepos(
  repos: { name: string; url: string; access: RepoAccessView | undefined }[],
): string[] {
  return repos.flatMap((repo) => {
    const lines: string[] = [];
    if (repo.access?.state === "not-member")
      lines.push(
        `${repo.name}: ${repo.access.fix ?? `请项目 Maintainer 把${repo.access.username ? `〈${repo.access.username}〉` : "令牌用户"}加为 Developer`}`,
      );
    if (repo.access?.state === "error") {
      const detail = repo.access.message ?? "unknown error";
      lines.push(
        repo.access.hostKind === "gitlab"
          ? `${repo.name}: 托管无法检查：${detail}`
          : `${repo.name}: the GitHub App could not be checked: ${detail}`,
      );
    }
    if (repo.access?.files?.gates === false)
      lines.push(
        `${repo.name} has no ${GATES_PATH} on its default branch or on ${SETUP_BRANCH}, so its tickets cannot pass a gate: set it up with the afk-setup skill, then confirm again`,
      );
    return lines;
  });
}

/**
 * Warnings for `plat tickets import`: an integration ticket starts the repos in its `environment` from their
 * compose files, which the spec itself can add (the environment is built from the spec's integration branches). It
 * is worth a word when a repo has none on its default branch or afk/setup and no ticket file here in that repo
 * mentions it.
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
        `${ticket.displayId} runs its e2e against ${repo}, which has no ${COMPOSE_PATH} on its default branch or on ${SETUP_BRANCH}, and no ticket here in ${repo} adds it: add one (see "Integration tickets" in docs/agents/issue-tracker.md)`,
      );
    }
  }
  return warnings;
}
