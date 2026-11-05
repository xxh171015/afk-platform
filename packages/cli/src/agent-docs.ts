import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GLOSSARY_MAP_PATH } from "@afk/shared";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { isTracked } from "./git-exclude.ts";
import { TRACKER_DOC_PATH } from "./init.ts";

// What `plat init` writes into the planning repo besides the tracker doc: what setup-matt-pocock-skills would write,
// so nobody has to run it (the skill's own rules, at the pinned SHA), and the planning conventions. Only the planning
// skills read these, so they stay on the planning machine (ADR 0007): files the repo does not track are written for
// this machine only, and the `## Agent skills` section goes into the local rule files Claude Code and Cursor read.
// A repo that already tracks a file keeps it there: docs/agents files are kept as they are, the tracker doc and a
// tracked `## Agent skills` section are updated in place.

export interface AgentDoc {
  path: string;
  before: string | null;
  after: string;
  tracked: boolean; // false: on this machine only, in .git/info/exclude
}

const DOMAIN_PATH = "docs/agents/domain.md";
const TRIAGE_PATH = "docs/agents/triage-labels.md";
export const CLAUDE_RULES_PATH = "CLAUDE.local.md";
export const CURSOR_RULES_PATH = ".cursor/rules/afk-platform.mdc";

function agentSkillsSection(multiContext: boolean): string {
  return [
    "## Agent skills",
    "",
    "### Issue tracker",
    "",
    `Specs and tickets live in the AFK platform (the \`plat\` CLI), not in the code host's issues. See \`${TRACKER_DOC_PATH}\`.`,
    "",
    "### Triage labels",
    "",
    `The default label strings: \`needs-triage\`, \`needs-info\`, \`ready-for-agent\`, \`ready-for-human\`, \`wontfix\`. See \`${TRIAGE_PATH}\`.`,
    "",
    "### Domain docs",
    "",
    multiContext
      ? `Multi-context: \`GLOSSARY-MAP.md\` at the repo root points at one \`GLOSSARY.md\` per context. See \`${DOMAIN_PATH}\`.`
      : `Single-context: one \`GLOSSARY.md\` and \`docs/adr/\` at the repo root. See \`${DOMAIN_PATH}\`.`,
    "",
  ].join("\n");
}

// Research and prototypes leave nothing in the person's checkout (GLOSSARY「Scratch files」).
function planningSection(afkHome: string): string {
  const worktrees = join(afkHome, "planning");
  return [
    "## Planning on this machine",
    "",
    `- Do research and prototypes in a temporary git worktree under \`${worktrees}\` (for example \`${join(worktrees, "research-<name>")}\`), never in this checkout: do not write files here for them or switch this checkout's branch.`,
    "- Push what they found to a `research/<name>` or `prototype/<name>` branch and keep that branch: the decision it informs links to it. Then remove the temporary worktree (`git worktree remove`).",
    "- Keep no notes of them on this machine.",
    "",
  ].join("\n");
}

// `section` (its first line is its `## ` heading) replaces the section of that heading up to the next level-two
// heading, or is appended.
const isHeading = (heading: string) => (line: string) =>
  line.trimEnd() === heading;

export function withSection(text: string, section: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(isHeading(section.split("\n")[0] as string));
  if (start === -1) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return body === "" ? section : `${body}\n${section}`;
  }
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  const head = lines.slice(0, start).join("\n");
  const tail = lines.slice(end).join("\n");
  return `${head}${start > 0 ? "\n" : ""}${section}${end < lines.length ? `\n${tail}` : ""}`;
}

// The text without the section of `heading`, up to the next level-two heading.
function withoutSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(isHeading(heading));
  if (start === -1) return text;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

const hasAgentSkills = (text: string | null) =>
  text !== null && text.split("\n").some(isHeading("## Agent skills"));

export function planAgentDocs(dir: string, afkHome: string): AgentDoc[] {
  const read = (path: string) =>
    existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;
  const docs: AgentDoc[] = [];
  for (const [path, template] of [
    [DOMAIN_PATH, "setup-matt-pocock-skills/domain.md"],
    [TRIAGE_PATH, "setup-matt-pocock-skills/triage-labels.md"],
  ] as const) {
    const before = read(path);
    docs.push({
      path,
      before,
      after: before ?? readSkillSnapshot(template),
      tracked: isTracked(dir, path),
    });
  }
  const skills = agentSkillsSection(existsSync(join(dir, GLOSSARY_MAP_PATH)));
  // a CLAUDE.md or AGENTS.md the repo tracks with the section already in it: updated there (as
  // setup-matt-pocock-skills would pick it, CLAUDE.md first)
  const owner = ["CLAUDE.md", "AGENTS.md"].find(
    (path) => isTracked(dir, path) && hasAgentSkills(read(path)),
  );
  if (owner !== undefined) {
    const before = read(owner);
    docs.push({
      path: owner,
      before,
      after: withSection(before ?? "", skills),
      tracked: true,
    });
  }
  // each tool's rule file has the section unless the tracked file that tool reads has it: Claude Code reads
  // CLAUDE.md, Cursor reads AGENTS.md
  const planning = planningSection(afkHome);
  const forClaude = owner === "CLAUDE.md" ? [planning] : [skills, planning];
  const forCursor = owner === "AGENTS.md" ? [planning] : [skills, planning];
  // CLAUDE.local.md may be the person's own too: only the platform's sections are replaced, and an Agent skills
  // section CLAUDE.md now has is taken out
  const claude = read(CLAUDE_RULES_PATH);
  docs.push({
    path: CLAUDE_RULES_PATH,
    before: claude,
    after: forClaude.reduce(
      withSection,
      owner === "CLAUDE.md"
        ? withoutSection(claude ?? "", "## Agent skills")
        : (claude ?? ""),
    ),
    tracked: isTracked(dir, CLAUDE_RULES_PATH),
  });
  docs.push({
    path: CURSOR_RULES_PATH,
    before: read(CURSOR_RULES_PATH),
    after: [
      "---",
      "description: How the planning skills reach the AFK platform from this checkout",
      "alwaysApply: true",
      "---",
      "",
      forCursor.join("\n"),
    ].join("\n"),
    tracked: isTracked(dir, CURSOR_RULES_PATH),
  });
  return docs;
}
