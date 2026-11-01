import { formatDisplayId } from "@afk/shared";

// The body of POST /specs/{id}/tickets/import for tests that only need some tickets in a spec: the tickets as
// plain objects, rendered as the ticket files plat reads from a directory. An edge from a new ticket into one the
// spec already has becomes `blocks` in the new ticket's front matter; any other edge becomes blocked_by/contract of
// the ticket it points to.

export interface TestTicket {
  key: string;
  repo: string;
  type: "contract" | "implementation" | "integration";
  title: string;
  body?: string;
  modules: string[];
  protected_paths_ok?: string[];
  acceptance: string[];
  blocked_by?: string[];
  contract?: string | string[];
  refs?: string[];
  environment?: string[];
}

export interface TestImport {
  tickets: TestTicket[];
  edges?: { from: string; to: string; kind?: "blocks" | "contract" }[];
}

const EXISTING = /^T-[1-9][0-9]*$/;

export function ticketFile(
  specId: number,
  ticket: TestTicket,
  extra: { blocked_by?: string[]; contract?: string[]; blocks?: string[] } = {},
): { name: string; text: string } {
  const list = (items: string[] | undefined) => JSON.stringify(items ?? []);
  const contract = [
    ...(ticket.contract === undefined ? [] : [ticket.contract].flat()),
    ...(extra.contract ?? []),
  ];
  const front = [
    "---",
    `title: ${JSON.stringify(ticket.title)}`,
    `repo: ${JSON.stringify(ticket.repo)}`,
    `type: ${ticket.type}`,
    `modules: ${list(ticket.modules)}`,
    `protected_paths_ok: ${list(ticket.protected_paths_ok)}`,
    `contract: ${list(contract)}`,
    `refs: ${list(ticket.refs)}`,
    `environment: ${list(ticket.environment)}`,
    `blocked_by: ${list([...(ticket.blocked_by ?? []), ...(extra.blocked_by ?? [])])}`,
    `blocks: ${list(extra.blocks)}`,
    "---",
    "",
  ].join("\n");
  const body = [
    "## Parent",
    "",
    formatDisplayId("spec", specId),
    "",
    "## What to build",
    "",
    ticket.body || "Do it.",
    "",
    "## Acceptance criteria",
    "",
    ...ticket.acceptance.map((line) => `- [ ] ${line}`),
    "",
  ].join("\n");
  return { name: `${ticket.key}.md`, text: front + body };
}

export function importBody(
  specId: number,
  file: { tickets: readonly object[]; edges?: readonly object[] },
) {
  return renderImport(specId, file as TestImport);
}

function renderImport(specId: number, file: TestImport) {
  const extras = new Map<
    string,
    { blocked_by: string[]; contract: string[]; blocks: string[] }
  >();
  const extraOf = (key: string) => {
    let extra = extras.get(key);
    if (!extra) {
      extra = { blocked_by: [], contract: [], blocks: [] };
      extras.set(key, extra);
    }
    return extra;
  };
  const keys = new Set(file.tickets.map((t) => t.key));
  for (const edge of file.edges ?? []) {
    if (keys.has(edge.to)) {
      extraOf(edge.to)[
        edge.kind === "contract" ? "contract" : "blocked_by"
      ].push(edge.from);
    } else if (EXISTING.test(edge.to) && edge.kind !== "contract") {
      extraOf(edge.from).blocks.push(edge.to);
    } else {
      throw new Error(
        `a test edge ${edge.from} -> ${edge.to} has no file form`,
      );
    }
  }
  return {
    files: file.tickets.map((t) => ticketFile(specId, t, extras.get(t.key))),
  };
}
