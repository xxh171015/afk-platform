import { readRepoText } from "./skills-snapshot-text.ts";

// What the platform takes from mattpocock/skills at SKILLS_SHA, copied unchanged into this repo by
// scripts/refresh-skills-snapshot.ts, so that a change upstream shows up as a diff when SKILLS_SHA is bumped. Each
// copy's folder has a VENDORED.md naming the SHA. Three places, by who reads them:
//   skills/                  afk-setup and the planning skills, carried inside plat and written into the planning repo
//   packages/pipeline/skills the skills the agents run in the sandbox, mounted read-only there by the worker
//   packages/shared/skills-snapshot  the seed templates plat init and plat tracker-doc write
export const VENDORED_DIRS = [
  "skills",
  "packages/pipeline/skills",
  "packages/shared/skills-snapshot",
] as const;

// Name → path upstream.
export const PLANNING_SKILLS = {
  "grill-with-docs": "skills/engineering/grill-with-docs",
  grilling: "skills/productivity/grilling",
  "domain-modeling": "skills/engineering/domain-modeling",
  "to-spec": "skills/engineering/to-spec",
  "to-tickets": "skills/engineering/to-tickets",
} as const;

// implement calls tdd, tdd reads codebase-design; the review stages run code-review.
export const SANDBOX_SKILLS = {
  implement: "skills/engineering/implement",
  tdd: "skills/engineering/tdd",
  "code-review": "skills/engineering/code-review",
  "codebase-design": "skills/engineering/codebase-design",
} as const;

// Seed templates, under skills/engineering upstream.
export const TEMPLATE_FILES = [
  "setup-matt-pocock-skills/issue-tracker-github.md",
  "setup-matt-pocock-skills/issue-tracker-gitlab.md",
  "setup-matt-pocock-skills/domain.md",
  "setup-matt-pocock-skills/triage-labels.md",
] as const;

// The files code reads, by name, and where each is kept in this repo.
const READ_FILES = {
  "to-spec/SKILL.md": "skills/to-spec/SKILL.md",
  "to-tickets/SKILL.md": "skills/to-tickets/SKILL.md",
  "implement/SKILL.md": "packages/pipeline/skills/implement/SKILL.md",
  "tdd/SKILL.md": "packages/pipeline/skills/tdd/SKILL.md",
  "code-review/SKILL.md": "packages/pipeline/skills/code-review/SKILL.md",
  ...Object.fromEntries(
    TEMPLATE_FILES.map((file) => [
      file,
      `packages/shared/skills-snapshot/${file}`,
    ]),
  ),
} as Record<SnapshotFile, string>;

export type SnapshotFile =
  | "to-spec/SKILL.md"
  | "to-tickets/SKILL.md"
  | "implement/SKILL.md"
  | "tdd/SKILL.md"
  | "code-review/SKILL.md"
  | (typeof TEMPLATE_FILES)[number];

export const SNAPSHOT_FILES = Object.keys(READ_FILES) as SnapshotFile[];

/** Where a file is kept, relative to the repo root. */
export const snapshotPath = (file: SnapshotFile): string => READ_FILES[file];

/** A file as written in the skills repo at SKILLS_SHA, byte for byte. */
export function readSkillSnapshot(file: SnapshotFile): string {
  return readRepoText(READ_FILES[file]);
}
