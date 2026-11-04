import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { TRACKER_DOC_PATH } from "./init.ts";

// What `plat init` writes into the planning repo besides the tracker doc: what setup-matt-pocock-skills would write,
// so nobody has to run it (the skill's own rules, at the pinned SHA). Files the repo already has are kept, except
// the `## Agent skills` section, which is the platform's.

export interface AgentDoc {
  path: string;
  before: string | null;
  after: string;
}

const DOMAIN_PATH = "docs/agents/domain.md";
const TRIAGE_PATH = "docs/agents/triage-labels.md";

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

// The section replaces an existing `## Agent skills` up to the next level-two heading, or is appended.
export function withAgentSkillsSection(text: string, section: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^## Agent skills\s*$/.test(line));
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

export function planAgentDocs(dir: string): AgentDoc[] {
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
    });
  }
  // setup-matt-pocock-skills: CLAUDE.md if there is one, else AGENTS.md (created when neither exists)
  const target = read("CLAUDE.md") !== null ? "CLAUDE.md" : "AGENTS.md";
  const before = read(target);
  const section = agentSkillsSection(existsSync(join(dir, "GLOSSARY-MAP.md")));
  docs.push({
    path: target,
    before,
    after: withAgentSkillsSection(before ?? "", section),
  });
  return docs;
}
