import { z } from "zod";
import { formatDisplayId } from "./display-id.ts";
import type { EdgeKind } from "./schemas.ts";

// The tickets.yaml that to-tickets produces (docs/design.md「导入格式」). Keys are snake_case as in the file.
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
  blocked_by: z.array(z.string().min(1)).default([]),
  contract: z.string().min(1).optional(),
});

export const ImportFileSchema = z.strictObject({
  spec: z.string().optional(),
  tickets: z.array(ImportTicketSchema).min(1).max(500),
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
  modules: string[];
  allowedProtectedPaths: string[];
}

// Both ends are the file's local keys; the caller swaps them for ticket ids.
export interface PlannedEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface ImportWarning {
  type: "module-overlap";
  tickets: [string, string];
  repoId: number;
  message: string;
}

export type ImportPlan =
  | {
      ok: true;
      tickets: PlannedTicket[];
      edges: PlannedEdge[];
      warnings: ImportWarning[];
    }
  | { ok: false; errors: string[] };

// Validates a whole import against the project's repos (role -> repo id). Pure: nothing is written, and every
// problem is reported at once so the author fixes the file in one pass.
export function planImport(
  input: unknown,
  repoIdsByRole: ReadonlyMap<string, number>,
  specId: number,
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

  const byKey = new Map<string, ImportFile["tickets"][number]>();
  for (const ticket of file.tickets) {
    if (byKey.has(ticket.key))
      errors.push(`duplicate ticket key ${ticket.key}`);
    byKey.set(ticket.key, ticket);
  }

  const edges: PlannedEdge[] = [];
  for (const ticket of file.tickets) {
    if (!repoIdsByRole.has(ticket.repo)) {
      errors.push(
        `ticket ${ticket.key}: repo ${ticket.repo} does not belong to the project`,
      );
    }
    const upstreams: [string, EdgeKind][] = [];
    for (const key of ticket.blocked_by) upstreams.push([key, "blocks"]);
    if (ticket.contract) upstreams.push([ticket.contract, "contract"]);
    for (const [upstream, kind] of upstreams) {
      const source = byKey.get(upstream);
      if (!source) {
        errors.push(`ticket ${ticket.key}: unknown ticket ${upstream}`);
      } else if (upstream === ticket.key) {
        errors.push(`ticket ${ticket.key} depends on itself`);
      } else if (kind === "contract" && source.type !== "contract") {
        errors.push(
          `ticket ${ticket.key}: ${upstream} is not a contract ticket, so it cannot be a contract edge upstream`,
        );
      } else {
        edges.push({ from: upstream, to: ticket.key, kind });
      }
    }
  }

  const cycle = findCycle(
    [...byKey.keys()],
    edges.map((edge) => [edge.from, edge.to]),
  );
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  if (errors.length > 0) return { ok: false, errors };

  const tickets = file.tickets.map(
    (ticket): PlannedTicket => ({
      key: ticket.key,
      repoId: repoIdsByRole.get(ticket.repo) as number,
      type: ticket.type,
      title: ticket.title,
      body: ticket.body,
      acceptanceCriteria: ticket.acceptance,
      modules: ticket.modules,
      allowedProtectedPaths: ticket.protected_paths_ok,
    }),
  );
  return {
    ok: true,
    tickets,
    edges,
    warnings: overlapWarnings(tickets, edges),
  };
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

function overlapWarnings(
  tickets: PlannedTicket[],
  edges: PlannedEdge[],
): ImportWarning[] {
  const next = new Map<string, string[]>(tickets.map((t) => [t.key, []]));
  for (const edge of edges) next.get(edge.from)?.push(edge.to);
  const reaches = (from: string, to: string): boolean => {
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

  const warnings: ImportWarning[] = [];
  for (const [i, a] of tickets.entries()) {
    for (const b of tickets.slice(i + 1)) {
      if (a.repoId !== b.repoId) continue;
      const overlapping = a.modules.some((x) =>
        b.modules.some((y) => globsOverlap(x, y)),
      );
      if (!overlapping || reaches(a.key, b.key) || reaches(b.key, a.key)) {
        continue;
      }
      warnings.push({
        type: "module-overlap",
        tickets: [a.key, b.key],
        repoId: a.repoId,
        message: `tickets ${a.key} and ${b.key} touch overlapping modules in the same repo but neither depends on the other`,
      });
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
