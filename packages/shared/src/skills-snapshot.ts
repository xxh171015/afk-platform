import { fileURLToPath } from "node:url";
import { readSnapshotText } from "./skills-snapshot-text.ts";

// Files of mattpocock/skills under skills/engineering that the platform depends on, committed in full under
// packages/shared/skills-snapshot/ so that a change upstream shows up as a diff when SKILLS_SHA is bumped.
export const SNAPSHOT_FILES = [
  "to-spec/SKILL.md",
  "to-tickets/SKILL.md",
  "implement/SKILL.md",
  "tdd/SKILL.md",
  "code-review/SKILL.md",
  "setup-matt-pocock-skills/issue-tracker-github.md",
  "setup-matt-pocock-skills/issue-tracker-gitlab.md",
  "setup-matt-pocock-skills/domain.md",
  "setup-matt-pocock-skills/triage-labels.md",
] as const;

export type SnapshotFile = (typeof SNAPSHOT_FILES)[number];

// The planning skills a planning machine runs, copied whole and unchanged under skills/ beside afk-setup, so that
// `npx skills@latest add xxh171015/afk-platform` installs them together, at SKILLS_SHA. Name → path upstream.
export const PLANNING_SKILLS = {
  "grill-with-docs": "skills/engineering/grill-with-docs",
  grilling: "skills/productivity/grilling",
  "domain-modeling": "skills/engineering/domain-modeling",
  "to-spec": "skills/engineering/to-spec",
  "to-tickets": "skills/engineering/to-tickets",
} as const;

export const SNAPSHOT_DIR = fileURLToPath(
  new URL("../skills-snapshot/", import.meta.url),
);

const HEADER = /^<!-- mattpocock\/skills@([0-9a-f]{40}) \S+ -->\n/;

export function snapshotHeader(sha: string, file: SnapshotFile): string {
  return `<!-- mattpocock/skills@${sha} skills/engineering/${file} -->\n`;
}

/** A snapshot file split into the SHA its header names and the upstream text after the header, byte for byte. */
export function readSkillSnapshot(file: SnapshotFile): {
  sha: string;
  content: string;
} {
  const text = readSnapshotText(file);
  const header = HEADER.exec(text);
  if (!header?.[1]) throw new Error(`${file}: the snapshot has no SHA header`);
  return { sha: header[1], content: text.slice(header[0].length) };
}
