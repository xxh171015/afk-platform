import { z } from "zod";
import { formatDisplayId } from "./display-id.ts";
import type { EdgeKind } from "./schemas.ts";
import { userStoriesOf } from "./spec-template.ts";

// What planImport checks: the tickets of a directory of ticket files, as readTicketFiles (ticket-files.ts) turns
// them (docs/design.md「导入格式」). Keys are snake_case as in the front matter.
// A planner may write only contract, implementation and integration tickets; the platform makes fix and system ones.
const ImportTicketSchema = z.strictObject({
  key: z.string().min(1),
  repo: z.string().min(1),
  type: z.enum(["contract", "implementation", "integration"]),
  title: z.string().min(1),
  body: z.string().default(""),
  modules: z.array(z.string().min(1)).min(1),
  protected_paths_ok: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
  stories: z.array(z.number().int().positive()).default([]),
  blocked_by: z.array(z.string().min(1)).default([]),
  // One upstream contract ticket, or several (at most one chain of them per repo).
  contract: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((value) => (typeof value === "string" ? [value] : value))
    .default([]),
  // Names of repos: read-only references for the agent, and (integration tickets only) the repos whose services
  // the e2e environment starts.
  refs: z.array(z.string().min(1)).default([]),
  environment: z.array(z.string().min(1)).default([]),
});

// An edge written on its own, for appending: it can run from a new ticket to an existing one, which no ticket's
// blocked_by / contract can say. Ends are the file's keys or T-<n> of existing tickets.
const ImportEdgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["blocks", "contract"]).default("blocks"),
});

export const ImportFileSchema = z.strictObject({
  spec: z.string().optional(),
  tickets: z.array(ImportTicketSchema).min(1).max(500),
  edges: z.array(ImportEdgeSchema).max(2000).default([]),
  external_blocked_by: z.array(z.string()).default([]),
});
export type ImportFile = z.infer<typeof ImportFileSchema>;

export interface PlannedTicket {
  key: string;
  repoId: number;
  type: "contract" | "implementation" | "integration";
  title: string;
  body: string;
  acceptanceCriteria: string[];
  stories: number[];
  modules: string[];
  allowedProtectedPaths: string[];
  refs: string[];
  environment: string[];
}

// What the validator needs to know about a repo of the project.
export interface ImportRepo {
  id: number;
  contractPath: string | null;
}

// Both ends are the file's local keys; the caller swaps them for ticket ids.
export interface PlannedEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface ImportWarning {
  type: "module-overlap" | "old-contract-pending" | "old-contract-started";
  tickets: [string, string];
  repoId: number;
  message: string;
}

// A warning also knows how to say itself with other names for its tickets (the keys of the file become the ids the
// tickets got), so nobody has to search a sentence for names.
export type PlannedWarning = ImportWarning & {
  describe(name: (key: string) => string): string;
};

const warning = (
  type: ImportWarning["type"],
  tickets: [string, string],
  repoId: number,
  describe: (name: (key: string) => string) => string,
): PlannedWarning =>
  // not enumerable, so the warning still compares and serialises as the plain ImportWarning it is
  Object.defineProperty(
    { type, tickets, repoId, message: describe((key) => key) },
    "describe",
    { value: describe },
  ) as PlannedWarning;

export type ImportPlan =
  | {
      ok: true;
      tickets: PlannedTicket[];
      edges: PlannedEdge[];
      warnings: PlannedWarning[];
    }
  | { ok: false; errors: string[] };

// The tickets a spec already has, when a file is appended to it. Keys are display ids (T-12). Cancelled tickets
// are only named, not part of the graph.
export interface ExistingGraph {
  tickets: {
    key: string;
    repo: string;
    repoId: number;
    type: string;
    state: string;
    modules: string[];
  }[];
  cancelled: string[];
  edges: PlannedEdge[];
}

const TICKET_KEY = /^T-[1-9][0-9]*$/;

// Validates a whole import against the project's repos (name -> repo). Pure: nothing is written, and every
// problem is reported at once so the author fixes the file in one pass. With `existing` the file is appended to a
// spec that has tickets: it may name them, and every rule is checked on the merged graph.
export function planImport(
  input: unknown,
  repos: ReadonlyMap<string, ImportRepo>,
  specId: number,
  existing?: ExistingGraph,
  specBody = "",
): ImportPlan {
  const parsed = ImportFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => describeIssue(input, issue)),
    };
  }
  const file = parsed.data;
  const errors: string[] = [];
  const knownStories = new Set(
    userStoriesOf(specBody).map((story) => story.number),
  );

  if (
    file.spec !== undefined &&
    file.spec !== formatDisplayId("spec", specId)
  ) {
    errors.push(
      `spec: the file names ${file.spec}, but it is being imported into ${formatDisplayId("spec", specId)}`,
    );
  }
  if (file.external_blocked_by.length > 0) {
    errors.push(
      `external_blocked_by must be empty in M1, got ${file.external_blocked_by.join(", ")}`,
    );
  }

  if (!existing && file.edges.length > 0) {
    errors.push("blocks can only be written in a file imported with --append");
  }

  const byKey = new Map<string, ImportFile["tickets"][number]>();
  for (const ticket of file.tickets) {
    if (byKey.has(ticket.key))
      errors.push(`duplicate ticket key ${ticket.key}`);
    if (existing && TICKET_KEY.test(ticket.key)) {
      errors.push(
        `ticket key ${ticket.key} looks like an existing ticket id; keys in an appended file must not be T-<n>`,
      );
    }
    byKey.set(ticket.key, ticket);
  }
  const old = new Map((existing?.tickets ?? []).map((t) => [t.key, t]));
  const cancelled = new Set(existing?.cancelled ?? []);
  // what an end of an edge is: a ticket of this file, an existing one, or nothing we can name
  const find = (key: string) => {
    const created = byKey.get(key);
    if (created) {
      return { isNew: true as const, repo: created.repo, type: created.type };
    }
    const kept = old.get(key);
    if (kept) {
      return {
        isNew: false as const,
        repo: kept.repo,
        type: kept.type,
        state: kept.state,
      };
    }
    return undefined;
  };
  const whyMissing = (key: string, where: string) =>
    cancelled.has(key)
      ? `${where}: ${key} is cancelled`
      : `${where}: unknown ticket ${key}`;

  const edges: PlannedEdge[] = [];
  const addEdge = (from: string, to: string, kind: EdgeKind, where: string) => {
    const source = find(from);
    const target = find(to);
    if (!source || !target) {
      if (!source) errors.push(whyMissing(from, where));
      if (!target) errors.push(whyMissing(to, where));
      return;
    }
    if (from === to) {
      errors.push(`${where}: depends on itself`);
    } else if (!source.isNew && !target.isNew) {
      errors.push(
        `${where}: edge ${from} -> ${to} joins two existing tickets; a new edge needs a new ticket at one end`,
      );
    } else if (
      !target.isNew &&
      !["pending", "blocked"].includes(target.state)
    ) {
      errors.push(
        `${where}: ${to} is ${target.state}, so it cannot be blocked by a new ticket; only a pending or blocked ticket can`,
      );
    } else if (kind === "contract" && source.type !== "contract") {
      errors.push(
        `${where}: ${from} is not a contract ticket, so it cannot be a contract edge upstream`,
      );
    } else if (kind === "contract" && !repos.get(source.repo)?.contractPath) {
      errors.push(
        `${where}: contract upstream ${from} is in repo ${source.repo}, which has no contract path; set it with plat repo edit ${source.repo} --project <id> --contract-path <path>`,
      );
    } else {
      edges.push({ from, to, kind });
    }
  };

  for (const ticket of file.tickets) {
    const where = `ticket ${ticket.key}`;
    if (!repos.has(ticket.repo)) {
      errors.push(
        `${where}: repo ${ticket.repo} does not belong to the project (its repos: ${[...repos.keys()].join(", ")}); if it is another repo, set it up with the afk-setup skill (its checkout is a workspace folder), then import again`,
      );
    }
    for (const key of ticket.blocked_by)
      addEdge(key, ticket.key, "blocks", where);
    if (new Set(ticket.contract).size !== ticket.contract.length) {
      errors.push(`${where}: contract lists the same ticket twice`);
    }
    for (const key of new Set(ticket.contract))
      addEdge(key, ticket.key, "contract", where);
    for (const name of ticket.refs) {
      if (!repos.has(name)) {
        errors.push(`${where}: refs ${name} does not belong to the project`);
      }
    }
    const unknownStories = [...new Set(ticket.stories)].filter(
      (n) => !knownStories.has(n),
    );
    if (unknownStories.length > 0) {
      errors.push(
        `${where}: stories ${unknownStories.join(", ")} are not User Story numbers in the spec`,
      );
    }
    if (ticket.environment.length > 0 && ticket.type !== "integration") {
      errors.push(
        `${where}: environment can only be written on an integration ticket`,
      );
    }
    for (const name of ticket.environment) {
      if (!repos.has(name)) {
        errors.push(
          `${where}: environment ${name} does not belong to the project`,
        );
      } else if (name === ticket.repo && ticket.type === "integration") {
        errors.push(`${where}: environment lists its own repo ${name}`);
      }
    }
  }
  for (const edge of file.edges) {
    addEdge(edge.from, edge.to, edge.kind, `edge ${edge.from} -> ${edge.to}`);
  }

  // The graph every rule below looks at: what the spec had plus what the file adds.
  const nodes: RepoTicket[] = [
    ...(existing?.tickets ?? []).map((t) => ({ key: t.key, repo: t.repo })),
    ...file.tickets.map((t) => ({ key: t.key, repo: t.repo })),
  ];
  const merged = [...(existing?.edges ?? []), ...edges];
  const cycle = findCycle(
    nodes.map((n) => n.key),
    merged.map((edge) => [edge.from, edge.to]),
  );
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  else {
    errors.push(...contractChainErrors(nodes, merged));
    errors.push(...repoCycleErrors(nodes, merged));
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };

  const tickets = file.tickets.map(
    (ticket): PlannedTicket => ({
      key: ticket.key,
      repoId: repos.get(ticket.repo)?.id as number,
      type: ticket.type,
      title: ticket.title,
      body: ticket.body,
      acceptanceCriteria: ticket.acceptance,
      stories: ticket.stories,
      modules: ticket.modules,
      allowedProtectedPaths: ticket.protected_paths_ok,
      refs: ticket.refs,
      environment: ticket.environment,
    }),
  );
  const everyone = [
    ...(existing?.tickets ?? []).map(
      (t): OverlapTicket => ({
        key: t.key,
        repoId: t.repoId,
        modules: t.modules,
      }),
    ),
    ...tickets,
  ];
  const created = new Set(tickets.map((t) => t.key));
  return {
    ok: true,
    tickets,
    edges,
    warnings: [
      ...overlapWarnings(everyone, merged).filter((w) =>
        w.tickets.some((key) => created.has(key)),
      ),
      ...(existing
        ? staleContractWarnings(file.tickets, repos, existing, merged)
        : []),
    ],
  };
}

interface RepoTicket {
  key: string;
  repo: string;
}

const reachable = (edges: readonly PlannedEdge[]) => {
  const next = new Map<string, string[]>();
  for (const edge of edges)
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  return (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    return false;
  };
};

// A ticket's contract upstreams in one repo must form a chain: any two of them depend on each other, so the
// newest one is the contract the ticket builds against.
function contractChainErrors(
  tickets: readonly RepoTicket[],
  edges: readonly PlannedEdge[],
): string[] {
  const repoOf = new Map(tickets.map((t) => [t.key, t.repo]));
  const reaches = reachable(edges);
  const errors: string[] = [];
  for (const ticket of tickets) {
    const byRepo = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.kind !== "contract" || edge.to !== ticket.key) continue;
      const repo = repoOf.get(edge.from) as string;
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), edge.from]);
    }
    for (const [repo, upstreams] of byRepo) {
      for (const [i, a] of upstreams.entries()) {
        for (const b of upstreams.slice(i + 1)) {
          if (!reaches(a, b) && !reaches(b, a)) {
            errors.push(
              `ticket ${ticket.key}: contract upstreams ${a} and ${b} are both in repo ${repo} but neither depends on the other; they must form a chain (add blocked_by from the later one to the earlier one)`,
            );
          }
        }
      }
    }
  }
  return errors;
}

// A contract edge from X to Y says Y's repo uses X's repo's contract; those relations between repos must not go round.
function repoCycleErrors(
  tickets: readonly RepoTicket[],
  edges: readonly PlannedEdge[],
): string[] {
  const repoOf = new Map(tickets.map((t) => [t.key, t.repo]));
  const pairs = new Set<string>();
  for (const edge of edges) {
    const from = repoOf.get(edge.from) as string;
    const to = repoOf.get(edge.to) as string;
    if (edge.kind === "contract" && from !== to) pairs.add(`${from}\0${to}`);
  }
  const cycle = findCycle(
    [...new Set(tickets.map((t) => t.repo))],
    [...pairs].map((pair) => pair.split("\0") as [string, string]),
  );
  return cycle
    ? [
        `repo contract cycle: ${cycle.join(" -> ")} (each repo's contract is used by the next)`,
      ]
    : [];
}

// A new contract ticket does not reopen what was built on an older contract of the same repo: its downstream
// tickets that were not moved under the new one are listed, by how far they have got.
function staleContractWarnings(
  created: ImportFile["tickets"],
  repos: ReadonlyMap<string, ImportRepo>,
  existing: ExistingGraph,
  edges: readonly PlannedEdge[],
): PlannedWarning[] {
  const reaches = reachable(edges);
  const stateOf = new Map(existing.tickets.map((t) => [t.key, t.state]));
  const warnings: PlannedWarning[] = [];
  for (const fresh of created.filter((t) => t.type === "contract")) {
    for (const older of existing.tickets) {
      if (older.type !== "contract" || older.repo !== fresh.repo) continue;
      for (const edge of existing.edges) {
        if (edge.from !== older.key || edge.kind !== "contract") continue;
        if (reaches(fresh.key, edge.to)) continue;
        const state = stateOf.get(edge.to);
        if (state === undefined) continue;
        const waiting = state === "pending" || state === "blocked";
        warnings.push(
          warning(
            waiting ? "old-contract-pending" : "old-contract-started",
            [edge.to, fresh.key],
            repos.get(fresh.repo)?.id ?? 0,
            (name) =>
              waiting
                ? `${edge.to} will keep using the old contract ${older.key}; connect it under the new contract ticket ${name(fresh.key)}?`
                : `${edge.to} is ${state} on the old contract ${older.key}; consider appending an adaptation ticket under ${name(fresh.key)}`,
          ),
        );
      }
    }
  }
  return warnings;
}

// Shape errors name the ticket by its key (when it has one) rather than its position in the file.
function describeIssue(input: unknown, issue: z.core.$ZodIssue): string {
  const [head, index, ...rest] = issue.path;
  if (head === "tickets" && typeof index === "number") {
    const raw = (input as { tickets?: unknown[] }).tickets?.[index];
    const key = (raw as { key?: unknown } | undefined)?.key;
    const where =
      typeof key === "string" ? `ticket ${key}` : `tickets[${index}]`;
    return `${where}: ${[...rest].join(".") || "(ticket)"} ${issue.message}`;
  }
  return `${issue.path.join(".") || "(file)"}: ${issue.message}`;
}

// One cycle as a closed path (a -> b -> a), or undefined. Depth-first with a colouring.
function findCycle(
  nodes: string[],
  edges: [string, string][],
): string[] | undefined {
  const next = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const [from, to] of edges) next.get(from)?.push(to);
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, "open");
    path.push(node);
    for (const target of next.get(node) ?? []) {
      if (state.get(target) === "open") {
        return [...path.slice(path.indexOf(target)), target];
      }
      if (!state.has(target)) {
        const found = visit(target);
        if (found) return found;
      }
    }
    path.pop();
    state.set(node, "done");
    return undefined;
  };
  for (const node of nodes) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return undefined;
}

type OverlapTicket = Pick<PlannedTicket, "key" | "repoId" | "modules">;

function overlapWarnings(
  tickets: OverlapTicket[],
  edges: readonly PlannedEdge[],
): PlannedWarning[] {
  const reaches = reachable(edges);

  const warnings: PlannedWarning[] = [];
  for (const [i, a] of tickets.entries()) {
    for (const b of tickets.slice(i + 1)) {
      if (a.repoId !== b.repoId) continue;
      const overlapping = a.modules.some((x) =>
        b.modules.some((y) => globsOverlap(x, y)),
      );
      if (!overlapping || reaches(a.key, b.key) || reaches(b.key, a.key)) {
        continue;
      }
      warnings.push(
        warning(
          "module-overlap",
          [a.key, b.key],
          a.repoId,
          (name) =>
            `tickets ${name(a.key)} and ${name(b.key)} touch overlapping modules in the same repo but neither depends on the other`,
        ),
      );
    }
  }
  return warnings;
}

// Conservative: true whenever some path could match both globs. Segment by segment; `**` matches any run of
// segments, `*` and `?` match within one segment.
export function globsOverlap(a: string, b: string): boolean {
  return segmentsOverlap(a.split("/"), b.split("/"));
}

function segmentsOverlap(a: string[], b: string[]): boolean {
  const [x, ...restA] = a;
  const [y, ...restB] = b;
  if (x === undefined && y === undefined) return true;
  if (x === "**") {
    // zero segments, or swallow one of b's
    return (
      segmentsOverlap(restA, b) ||
      (y !== undefined && segmentsOverlap(a, restB))
    );
  }
  if (y === "**") {
    return (
      segmentsOverlap(a, restB) ||
      (x !== undefined && segmentsOverlap(restA, b))
    );
  }
  if (x === undefined || y === undefined) return false;
  return segmentOverlap(x, y) && segmentsOverlap(restA, restB);
}

const hasWildcard = (segment: string) => /[*?]/.test(segment);

function segmentOverlap(x: string, y: string): boolean {
  if (!hasWildcard(x) && !hasWildcard(y)) return x === y;
  if (!hasWildcard(x)) return segmentRegex(y).test(x);
  if (!hasWildcard(y)) return segmentRegex(x).test(y);
  return true; // two patterns in one segment: assume they can meet
}

function segmentRegex(pattern: string): RegExp {
  const source = [...pattern]
    .map((char) =>
      char === "*"
        ? ".*"
        : char === "?"
          ? "."
          : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}
