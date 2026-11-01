import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { formatDisplayId } from "./display-id.ts";
import { readSkillSnapshot } from "./skills-snapshot.ts";
import type { ImportFile } from "./ticket-import.ts";

// A ticket is one markdown file: a front matter with the title and the platform's fields, then the body, which is
// to-tickets' issue template as the skill wrote it (ADR 0001). This turns a directory of them into the input of
// planImport. The body is kept as written but for CRLF -> LF and the blank lines at its end; the acceptance
// criteria are read out of it, never written a second time.
//
// Not exported from the package entry: the section names come from the skills snapshot, which is read from disk.

export interface TicketFile {
  name: string; // the file's name, e.g. be-export.md
  text: string;
}

export type TicketFilesResult =
  | { ok: true; input: Pick<ImportFile, "tickets" | "edges"> }
  // `parsed` is what the readable files make, and `failed` the keys of the ones that were not: the caller can check
  // the rest of the graph and list its problems with the files' own.
  | {
      ok: false;
      errors: string[];
      parsed: Pick<ImportFile, "tickets" | "edges">;
      failed: string[];
    };

const FrontMatter = z.strictObject({
  title: z.string().min(1),
  repo: z.string().min(1),
  type: z.enum(["contract", "implementation", "integration"]),
  modules: z.array(z.string().min(1)).min(1),
  protected_paths_ok: z.array(z.string().min(1)).default([]),
  // One upstream contract ticket, or several (at most one chain of them per repo).
  contract: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((value) => (typeof value === "string" ? [value] : value))
    .default([]),
  refs: z.array(z.string().min(1)).default([]),
  environment: z.array(z.string().min(1)).default([]),
  blocked_by: z.array(z.string().min(1)).default([]),
  // Tickets this one blocks: for appending, where the blocked ticket already exists (T-<n>).
  blocks: z.array(z.string().min(1)).default([]),
});

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CRITERION = /^- \[ \] (\S.*)$/;

// The section names of the issue template in the pinned to-tickets skill.
function templateSections(): {
  parent: string;
  acceptance: string;
  blockedBy: string;
} {
  const skill = readSkillSnapshot("to-tickets/SKILL.md").content;
  const template = /<issue-template>([\s\S]*?)<\/issue-template>/.exec(
    skill,
  )?.[1];
  const names = [...(template ?? "").matchAll(/^## (.+?)\s*$/gm)].map(
    (m) => m[1] as string,
  );
  const named = (pattern: RegExp) => {
    const found = names.find((n) => pattern.test(n));
    if (!found)
      throw new Error(
        `the to-tickets issue template has no ${pattern} section`,
      );
    return found;
  };
  return {
    parent: named(/^parent$/i),
    acceptance: named(/^acceptance criteria$/i),
    blockedBy: named(/^blocked by$/i),
  };
}

interface Section {
  name: string;
  line: number; // 1-based line of the heading in the file
  lines: { line: number; text: string }[];
}

// The `## ` sections of a body. A heading inside a code fence is text.
function sectionsOf(body: string, firstLine: number): Section[] {
  const sections: Section[] = [];
  let fence: string | undefined;
  body.split("\n").forEach((text, index) => {
    const line = firstLine + index;
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    }
    const heading = fence === undefined ? /^## (.+?)\s*$/.exec(text) : null;
    if (heading) sections.push({ name: heading[1] as string, line, lines: [] });
    else sections.at(-1)?.lines.push({ line, text });
  });
  return sections;
}

// The front matter and the body of a ticket file, with the line the body starts on.
function splitFile(
  where: string,
  rawText: string,
): { front: string; body: string; firstBodyLine: number } | string[] {
  const text = rawText.replace(/\r\n/g, "\n");
  const opening = /^---\n/.exec(text);
  if (!opening)
    return [`${where}: the file must start with a --- front matter`];
  const closing = /^---[ \t]*$/m.exec(text.slice(opening[0].length));
  if (!closing)
    return [`${where}: the front matter is not closed by a --- line`];
  const front = text.slice(
    opening[0].length,
    opening[0].length + closing.index,
  );
  const afterFront = opening[0].length + closing.index + closing[0].length;
  // the body starts on the line after the closing ---
  const bodyStart = text[afterFront] === "\n" ? afterFront + 1 : afterFront;
  const firstBodyLine = text.slice(0, bodyStart).split("\n").length;
  const body = `${text.slice(bodyStart).replace(/\n+$/, "")}\n`;
  return { front, body, firstBodyLine };
}

function parseFront<T extends z.ZodType>(
  where: string,
  front: string,
  schema: T,
): { value: z.output<T> } | { errors: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(front);
  } catch (error) {
    return {
      errors: [
        `${where}: the front matter is not valid YAML: ${(error as Error).message}`,
      ],
    };
  }
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { value: parsed.data };
  return {
    errors: parsed.error.issues.map(
      (issue) =>
        `${where}: front matter ${issue.path.join(".") || "(whole)"}: ${issue.message}`,
    ),
  };
}

// The checks on a body that hold for an imported ticket and an edited one alike: it names the spec as its parent,
// has no Blocked by section, and its acceptance criteria are single-line checkboxes. Returns the criteria.
function readBody(
  where: string,
  body: string,
  firstBodyLine: number,
  specShown: string,
  names: ReturnType<typeof templateSections>,
  errors: string[],
): string[] {
  const sections = sectionsOf(body, firstBodyLine);
  const section = (name: string) => sections.find((s) => s.name === name);
  const parent = section(names.parent);
  if (!parent) {
    errors.push(
      `${where}: no \`## ${names.parent}\` section; it names ${specShown}`,
    );
  } else {
    const content = parent.lines.filter((l) => l.text.trim() !== "");
    const first = content[0];
    if (!first || content.length > 1 || first.text.trim() !== specShown) {
      errors.push(
        `${where}:${first?.line ?? parent.line}: \`## ${names.parent}\` must be ${specShown}, the spec being imported into`,
      );
    }
  }
  const blocker = section(names.blockedBy);
  if (blocker)
    errors.push(
      `${where}:${blocker.line}: \`## ${names.blockedBy}\` is not allowed; write the dependencies in the front matter (blocked_by, contract)`,
    );

  const acceptance: string[] = [];
  const criteria = section(names.acceptance);
  if (!criteria) {
    errors.push(`${where}: no \`## ${names.acceptance}\` section`);
  } else {
    let strays = 0;
    for (const { line, text: row } of criteria.lines) {
      if (row.trim() === "") continue;
      const match = CRITERION.exec(row);
      if (match) acceptance.push(match[1] as string);
      else {
        strays++;
        errors.push(
          `${where}:${line}: every line of \`## ${names.acceptance}\` must be a single-line \`- [ ] text\`, got ${JSON.stringify(row)}`,
        );
      }
    }
    if (acceptance.length === 0 && strays === 0)
      errors.push(
        `${where}:${criteria.line}: \`## ${names.acceptance}\` is empty`,
      );
  }
  return acceptance;
}

function readTicket(
  file: TicketFile,
  specShown: string,
  names: ReturnType<typeof templateSections>,
): { ticket: ImportFile["tickets"][number]; blocks: string[] } | string[] {
  const where = file.name;
  const split = splitFile(where, file.text);
  if (Array.isArray(split)) return split;
  const { front, body, firstBodyLine } = split;
  const parsed = parseFront(where, front, FrontMatter);
  const errors: string[] = "errors" in parsed ? [...parsed.errors] : [];
  const key = file.name.replace(/\.md$/, "");
  if (!KEY.test(key))
    errors.push(
      `${where}: the file name (without .md) is the ticket's key, and may only hold letters, digits, . _ -`,
    );
  const acceptance = readBody(
    where,
    body,
    firstBodyLine,
    specShown,
    names,
    errors,
  );
  if (errors.length > 0 || !("value" in parsed)) return errors;
  const { blocks, ...fields } = parsed.value;
  return {
    ticket: { key, ...fields, body, acceptance },
    blocks,
  };
}

// The tickets are created in the order of `files`: the caller lists them by file name, which to-tickets numbers in
// dependency order.
export function readTicketFiles(
  files: readonly TicketFile[],
  specId: number,
): TicketFilesResult {
  const errors: string[] = [];
  const failed: string[] = [];
  const names = templateSections();
  const specShown = formatDisplayId("spec", specId);
  const tickets: ImportFile["tickets"] = [];
  const edges: ImportFile["edges"] = [];
  for (const file of files) {
    if (/\.ya?ml$/i.test(file.name)) {
      errors.push(
        `${file.name}: tickets.yaml is no longer accepted; write one markdown file per ticket (the to-tickets issue template under a front matter) in a directory`,
      );
      continue;
    }
    if (!file.name.endsWith(".md")) {
      errors.push(`${file.name}: a ticket file must be a .md file`);
      continue;
    }
    const read = readTicket(file, specShown, names);
    if (Array.isArray(read)) {
      errors.push(...read);
      failed.push(file.name.replace(/\.md$/, ""));
      continue;
    }
    tickets.push(read.ticket);
    for (const to of read.blocks)
      edges.push({ from: read.ticket.key, to, kind: "blocks" });
  }
  if (files.length === 0) errors.push("the directory has no ticket file (.md)");
  return errors.length > 0
    ? { ok: false, errors, parsed: { tickets, edges }, failed }
    : { ok: true, input: { tickets, edges } };
}

// What `plat ticket edit --file` reads: the file `plat ticket view --md` prints. Title, body and modules can be
// changed; the fields that cannot are optional, and compared with the ticket by the caller.
const EditFront = z.strictObject({
  id: z.string().optional(),
  version: z.number().int().optional(),
  title: z.string().min(1),
  modules: z.array(z.string().min(1)).min(1),
  protected_paths_ok: z.array(z.string().min(1)).optional(),
  repo: z.string().optional(),
  type: z.string().optional(),
  contract: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (typeof value === "string" ? [value] : value))
    .optional(),
  refs: z.array(z.string()).optional(),
  environment: z.array(z.string()).optional(),
  blocked_by: z.array(z.string()).optional(),
});

export type TicketEditFile = Omit<z.output<typeof EditFront>, "version"> & {
  body: string;
  acceptance: string[];
};

export function readTicketEditFile(
  text: string,
  specId: number,
): { ok: true; edit: TicketEditFile } | { ok: false; errors: string[] } {
  const where = "the ticket file";
  const split = splitFile(where, text);
  if (Array.isArray(split)) return { ok: false, errors: split };
  const parsed = parseFront(where, split.front, EditFront);
  const errors: string[] = "errors" in parsed ? [...parsed.errors] : [];
  const acceptance = readBody(
    where,
    split.body,
    split.firstBodyLine,
    formatDisplayId("spec", specId),
    templateSections(),
    errors,
  );
  if (errors.length > 0 || !("value" in parsed)) return { ok: false, errors };
  // the version the file was printed at is only there to be read: an edit applies to the ticket as it is now
  const { version: _version, ...fields } = parsed.value;
  return { ok: true, edit: { ...fields, body: split.body, acceptance } };
}

// The file of a ticket as an agent reads it, `plat ticket view --md` prints it and `plat ticket edit --file` takes
// it back: the front matter, then the body exactly as stored. Dependencies are named by T-<n>.
export interface TicketFileView {
  id: string;
  version: number;
  title: string;
  repo: string;
  type: string;
  modules: string[];
  protectedPathsOk: string[];
  contract: string[];
  refs: string[];
  environment: string[];
  blockedBy: string[];
  body: string;
}

export function renderTicketFile(ticket: TicketFileView): string {
  const front = stringifyYaml({
    id: ticket.id,
    version: ticket.version,
    title: ticket.title,
    repo: ticket.repo,
    type: ticket.type,
    modules: ticket.modules,
    protected_paths_ok: ticket.protectedPathsOk,
    contract: ticket.contract,
    refs: ticket.refs,
    environment: ticket.environment,
    blocked_by: ticket.blockedBy,
  });
  return `---\n${front}---\n${ticket.body}`;
}

// The acceptance criteria of a body written by the platform itself (a fix ticket), read by the same rules as an
// imported or edited one. Throws when the body does not follow the template: that is a mistake in the platform.
export function acceptanceOfBody(body: string, specId: number): string[] {
  const errors: string[] = [];
  const acceptance = readBody(
    "the ticket body",
    body,
    1,
    formatDisplayId("spec", specId),
    templateSections(),
    errors,
  );
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return acceptance;
}
