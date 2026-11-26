import {
  DEFAULT_TICKET_REVIEW,
  type ExistingGraph,
  formatDisplayId,
  type HostKind,
  type ImportWarning,
  type LimitOverrides,
  type MergePolicy,
  mergeStageModels,
  type PlanningDocsAtImport,
  parseDisplayId,
  parseStageModels,
  planImport,
  resolveLimits,
  type SPEC_TYPES,
  type SpecState,
  type StageModels,
  specTransition,
  storedMergePolicy,
  type TicketReviewMode,
} from "@afk/shared";
import { readTicketFiles, type TicketFile } from "@afk/shared/ticket-files";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import { applyOrigin } from "../events/origin.ts";
import { deleteFinalE2e } from "../finalize/final-e2e.ts";
import { hostKindOf, mixedHostsWith } from "../host/code-hosts.ts";
import { enqueuePrDraft, stopAutoMergeJobs } from "../host/host-jobs.ts";
import { inTransaction, schedulePass } from "../scheduling/scheduler.ts";
import { snapshotTicket } from "../tickets/versions.ts";
import { ensureIntegrationBranches } from "./integration-branches.ts";
import {
  pinSha,
  resolveSpecRefs,
  SHA_RE,
  type SpecRefInput,
  type SpecRefPin,
} from "./spec-refs.ts";

// Registering projects, repos and specs, and importing a spec's whole ticket graph
// (docs/specs/m1-platform.md「plat CLI」, docs/design.md「导入格式」).

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === UNIQUE_VIOLATION;

export interface NewProject {
  name: string;
  defaultAgent?: string;
  defaultModel?: string;
  protectedPaths?: string[];
  maxConcurrency?: number;
  budgetLimit?: number;
  mergePolicy?: MergePolicy | "";
  limits?: LimitOverrides;
  ticketReview?: TicketReviewMode;
  stageModels?: StageModels;
  tidy?: boolean;
}

export async function createProject(
  pool: pg.Pool,
  project: NewProject,
): Promise<{ id: number; name: string }> {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, default_agent, default_model, protected_paths, max_concurrency, budget_limit, merge_policy, limits, ticket_review, stage_models, tidy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, name`,
    [
      project.name,
      project.defaultAgent ?? null,
      project.defaultModel ?? null,
      project.protectedPaths ?? [],
      project.maxConcurrency ?? null,
      project.budgetLimit ?? null,
      storedMergePolicy(project.mergePolicy),
      JSON.stringify(project.limits ?? {}),
      project.ticketReview ?? DEFAULT_TICKET_REVIEW,
      JSON.stringify(parseStageModels(project.stageModels ?? {})),
      project.tidy ?? true,
    ],
  );
  return rows[0];
}

export type ProjectEdit = Partial<
  Pick<
    NewProject,
    | "defaultAgent"
    | "defaultModel"
    | "protectedPaths"
    | "maxConcurrency"
    | "budgetLimit"
    | "mergePolicy"
    | "limits"
    | "ticketReview"
    | "stageModels"
    | "tidy"
  >
> & {
  feishuChatId?: string | null;
};

// Only the fields that are given change. Limits are merged key by key over the stored overrides; protected paths
// are replaced as a whole. Tickets already made keep what they have; bundles are built from the project when read.
export async function editProject(
  pool: pg.Pool,
  projectId: number,
  edit: ProjectEdit,
): Promise<{ status: "ok" } | { status: "no-project" }> {
  const values: unknown[] = [projectId];
  const assignments: string[] = [];
  const set = (column: string, value: unknown, expression = "$") => {
    values.push(value);
    assignments.push(
      `${column} = ${expression.replace("$", `$${values.length}`)}`,
    );
  };
  if (edit.defaultAgent !== undefined) set("default_agent", edit.defaultAgent);
  if (edit.defaultModel !== undefined) set("default_model", edit.defaultModel);
  if (edit.protectedPaths !== undefined)
    set("protected_paths", edit.protectedPaths);
  if (edit.maxConcurrency !== undefined)
    set("max_concurrency", edit.maxConcurrency);
  if (edit.budgetLimit !== undefined) set("budget_limit", edit.budgetLimit);
  if (edit.mergePolicy !== undefined)
    set("merge_policy", storedMergePolicy(edit.mergePolicy));
  if (edit.limits !== undefined)
    set("limits", JSON.stringify(edit.limits), "limits || $::jsonb");
  if (edit.feishuChatId !== undefined)
    set("feishu_chat_id", edit.feishuChatId === "" ? null : edit.feishuChatId);
  if (edit.ticketReview !== undefined) set("ticket_review", edit.ticketReview);
  if (edit.tidy !== undefined) set("tidy", edit.tidy);
  if (edit.stageModels !== undefined) {
    const current = await pool.query(
      "SELECT stage_models FROM projects WHERE id = $1",
      [projectId],
    );
    if (current.rowCount === 0) return { status: "no-project" };
    set(
      "stage_models",
      JSON.stringify(
        mergeStageModels(current.rows[0].stage_models, edit.stageModels),
      ),
    );
  }
  // An empty edit still has to tell a missing project from an existing one.
  const { rowCount } = await pool.query(
    `UPDATE projects SET ${assignments.join(", ") || "id = id"} WHERE id = $1`,
    values,
  );
  return rowCount === 0 ? { status: "no-project" } : { status: "ok" };
}

export interface NewRepo {
  projectId: number;
  url: string;
  // How a ticket file names the repo; unique within the project.
  name: string;
  defaultBranch?: string;
  // Default: worked out from the address.
  hostKind?: HostKind;
}

export type AddRepoResult =
  | { status: "ok"; repo: { id: number; name: string } }
  | { status: "no-project" }
  | { status: "name-taken" }
  | { status: "mixed-hosts"; message: string };

export async function addRepo(
  pool: pg.Pool,
  repo: NewRepo,
): Promise<AddRepoResult> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    repo.projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  const hostKind = repo.hostKind ?? (await hostKindOf(pool, repo.url));
  const mixed = await mixedHostsWith(pool, repo.projectId, {
    name: repo.name,
    hostKind,
  });
  if (mixed) return { status: "mixed-hosts", message: mixed };
  try {
    const { rows } = await pool.query(
      `INSERT INTO repos (project_id, url, default_branch, name, host_kind) VALUES ($1, $2, COALESCE($3, 'main'), $4, $5)
       RETURNING id, name`,
      [
        repo.projectId,
        repo.url,
        repo.defaultBranch ?? null,
        repo.name,
        hostKind,
      ],
    );
    return { status: "ok", repo: rows[0] };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "name-taken" };
    throw error;
  }
}

export interface RepoEdit {
  // The path of the repo's contract file in the repo; an empty string says the repo owns none.
  contractPath?: string;
  // The code host the repo is on; it picks the seed template of the tracker doc.
  hostKind?: HostKind;
}

export type EditRepoResult =
  | { status: "ok"; repo: { id: number; name: string } }
  | { status: "no-project" }
  | { status: "no-repo" };

// Only the fields that are given change. Tickets already made read the path when their bundle is built.
export async function editRepo(
  pool: pg.Pool,
  projectId: number,
  name: string,
  edit: RepoEdit,
): Promise<EditRepoResult> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  const { rows } = await pool.query(
    `UPDATE repos SET contract_path = CASE WHEN $3::boolean THEN NULLIF($4::text, '') ELSE contract_path END,
       host_kind = COALESCE($5, host_kind)
     WHERE project_id = $1 AND name = $2 RETURNING id, name`,
    [
      projectId,
      name,
      edit.contractPath !== undefined,
      edit.contractPath ?? null,
      edit.hostKind ?? null,
    ],
  );
  return rows[0] ? { status: "ok", repo: rows[0] } : { status: "no-repo" };
}

export interface NewSpec {
  projectId: number;
  type: (typeof SPEC_TYPES)[number];
  slug: string;
  title: string;
  body?: string;
  // The repo plat spec create ran in (its tracker doc names it): the spec's planning repo.
  planningRepo?: string;
  // A bug may point at the spec it came from (GLOSSARY Spec). Omitted or undefined: none.
  sourceSpecId?: number;
  refs?: SpecRefInput[];
  now?: Date;
}

export type CreateSpecResult =
  | { status: "ok"; spec: { id: number; displayId: string } }
  | { status: "no-project" }
  | { status: "no-repo"; message: string }
  | { status: "slug-taken" }
  | { status: "invalid-source"; message: string }
  | { status: "unknown-host"; message: string };

export async function createSpec(
  pool: pg.Pool,
  spec: NewSpec,
): Promise<CreateSpecResult> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    spec.projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  const source = await resolveSourceSpec(pool, spec);
  if (source.status === "invalid-source") return source;
  let planningRepoId: number | null = null;
  if (spec.planningRepo !== undefined) {
    const repo = await pool.query<{ id: number }>(
      "SELECT id FROM repos WHERE project_id = $1 AND name = $2",
      [spec.projectId, spec.planningRepo],
    );
    if (!repo.rows[0]) {
      return {
        status: "no-repo",
        message: `the project has no repo named ${spec.planningRepo}`,
      };
    }
    planningRepoId = repo.rows[0].id;
  }
  try {
    // in a transaction, so the spec's first event says who made it
    return await inTransaction(pool, async (client) => {
      const resolved =
        spec.refs && spec.refs.length > 0
          ? await resolveSpecRefs(
              client,
              spec.projectId,
              spec.refs,
              spec.now ?? new Date(),
            )
          : { status: "ok" as const, refs: [] };
      if (resolved.status === "unknown-host") return resolved;
      const { rows } = await client.query(
        `INSERT INTO specs (project_id, type, slug, title, body, branch_namespace, planning_repo_id, source_spec_id, refs)
       SELECT $1, $2, $3, $4, $5, id, $6, $7, $8::jsonb FROM instance RETURNING id`,
        [
          spec.projectId,
          spec.type,
          spec.slug,
          spec.title,
          spec.body ?? "",
          planningRepoId,
          source.sourceSpecId,
          JSON.stringify(resolved.refs),
        ],
      );
      const id = rows[0].id as number;
      return {
        status: "ok" as const,
        spec: { id, displayId: formatDisplayId("spec", id) },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "slug-taken" };
    throw error;
  }
}

const EDITABLE_REF_STATES: readonly SpecState[] = [
  "draft",
  "planned",
  "running",
  "reworking",
  "paused",
];

export interface SpecRefsEdit {
  add?: SpecRefInput[];
  remove?: { repoId: number }[];
  refresh?: { repoId: number; sha: string }[];
  now?: Date;
}

export type EditSpecRefsResult =
  | { status: "ok" }
  | { status: "no-spec" }
  | { status: "not-editable"; message: string }
  | { status: "invalid"; message: string }
  | { status: "unknown-host"; message: string };

export async function editSpecRefs(
  pool: pg.Pool,
  specId: number,
  edit: SpecRefsEdit,
): Promise<EditSpecRefsResult> {
  return inTransaction(pool, async (client) => {
    const spec = await client.query<{
      project_id: number;
      state: SpecState;
      refs: SpecRefPin[];
    }>("SELECT project_id, state, refs FROM specs WHERE id = $1 FOR UPDATE", [
      specId,
    ]);
    if (spec.rowCount === 0) return { status: "no-spec" };
    const row = spec.rows[0];
    const shownId = formatDisplayId("spec", specId);
    if (!EDITABLE_REF_STATES.includes(row.state)) {
      return {
        status: "not-editable",
        message: `${shownId} is ${row.state}; reference repos can be edited while it is draft, planned, running, reworking or paused`,
      };
    }
    const confirmed = row.state !== "draft";
    let refs = [...row.refs];
    const byId = new Map(refs.map((ref) => [ref.repoId, ref]));

    if (edit.add && edit.add.length > 0) {
      if (confirmed) {
        const missing = edit.add.find((input) => !SHA_RE.test(input.sha ?? ""));
        if (missing) {
          return {
            status: "invalid",
            message: `${shownId} is confirmed; adding a reference repo needs a 40-character SHA`,
          };
        }
      }
      const resolved = await resolveSpecRefs(
        client,
        row.project_id,
        confirmed
          ? edit.add
          : edit.add.map((input) => ({ ...input, sha: null })),
        edit.now ?? new Date(),
      );
      if (resolved.status === "unknown-host") return resolved;
      for (const pin of resolved.refs) {
        const previous = byId.get(pin.repoId);
        if (previous) {
          previous.sha = pin.sha ?? previous.sha;
        } else {
          refs.push(pin);
          byId.set(pin.repoId, pin);
        }
      }
    }

    for (const item of edit.remove ?? []) {
      if (!byId.has(item.repoId)) {
        return {
          status: "invalid",
          message: `${shownId} has no reference repo ${item.repoId}`,
        };
      }
      refs = refs.filter((ref) => ref.repoId !== item.repoId);
      byId.delete(item.repoId);
    }

    for (const item of edit.refresh ?? []) {
      const sha = pinSha(item.sha);
      if (!sha || !SHA_RE.test(sha)) {
        return {
          status: "invalid",
          message: `${shownId}: refreshing a reference repo needs a 40-character SHA`,
        };
      }
      const current = byId.get(item.repoId);
      if (!current) {
        return {
          status: "invalid",
          message: `${shownId} has no reference repo ${item.repoId}`,
        };
      }
      current.sha = sha;
    }

    await client.query("UPDATE specs SET refs = $2::jsonb WHERE id = $1", [
      specId,
      JSON.stringify(refs),
    ]);
    await recordAction(
      client,
      "edit-refs",
      { specId },
      {
        add: edit.add,
        remove: edit.remove,
        refresh: edit.refresh,
      },
    );
    return { status: "ok" };
  });
}

export interface ImportedTicket {
  key: string;
  id: number;
  displayId: string;
}

export type ImportResult =
  | { status: "ok"; tickets: ImportedTicket[]; warnings: ImportWarning[] }
  | { status: "no-spec" }
  | { status: "not-importable"; message: string }
  | { status: "invalid"; errors: string[] };

const APPENDABLE_STATES: readonly SpecState[] = [
  "planned",
  "running",
  "paused",
  "awaiting-review",
];

function appendableStatesPhrase(): string {
  const last = APPENDABLE_STATES[APPENDABLE_STATES.length - 1];
  return `${APPENDABLE_STATES.slice(0, -1).join(", ")} or ${last}`;
}

// All or nothing: the file is validated first, then written in one transaction. The spec row is locked, so
// two imports of the same spec cannot both pass the "no tickets yet" check. With `append` the file is added to a
// spec that is already confirmed (planned, running, paused, or awaiting-review): the new tickets are scheduled
// at once. Appending to awaiting-review moves the spec to reworking.
export async function importTickets(
  pool: pg.Pool,
  specId: number,
  files: readonly TicketFile[],
  options: {
    append?: boolean;
    planningDocsAtImport?: PlanningDocsAtImport;
  } = {},
): Promise<ImportResult> {
  const append = options.append === true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyOrigin(client);
    const spec = await client.query(
      "SELECT project_id, state, slug, branch_namespace, integration_branches, import_warnings, body, refs FROM specs WHERE id = $1 FOR UPDATE",
      [specId],
    );
    if (spec.rowCount === 0)
      return await rollback(client, { status: "no-spec" });
    const specRow = spec.rows[0];
    const shownId = formatDisplayId("spec", specId);
    if (append) {
      if (specRow.state === "draft") {
        return await rollback(client, {
          status: "not-importable",
          message: `${shownId} is a draft; import its tickets without --append`,
        });
      }
      if (!APPENDABLE_STATES.includes(specRow.state as SpecState)) {
        return await rollback(client, {
          status: "not-importable",
          message: `${shownId} is ${specRow.state}; tickets can only be appended while it is ${appendableStatesPhrase()}`,
        });
      }
    } else {
      if (specRow.state !== "draft") {
        return await rollback(client, {
          status: "not-importable",
          message: `${shownId} is ${specRow.state}; tickets can only be imported while it is a draft (to add to a confirmed spec use --append)`,
        });
      }
      const existing = await client.query(
        "SELECT 1 FROM tickets WHERE spec_id = $1 LIMIT 1",
        [specId],
      );
      if (existing.rowCount !== 0) {
        return await rollback(client, {
          status: "not-importable",
          message: `${shownId} already has tickets; the import is all at once`,
        });
      }
    }

    const specRefIds = new Set(
      ((specRow.refs as { repoId: number }[] | null) ?? []).map(
        (ref) => ref.repoId,
      ),
    );
    const repos = await client.query(
      "SELECT name, id, contract_path, reference FROM repos WHERE project_id = $1",
      [specRow.project_id],
    );
    const project = await client.query(
      "SELECT limits, max_concurrency FROM projects WHERE id = $1",
      [specRow.project_id],
    );
    const { limits: stored, max_concurrency: maxConcurrency } = project.rows[0];
    const limits = resolveLimits({
      ...(maxConcurrency ? { projectConcurrency: maxConcurrency } : {}),
      ...stored,
    });
    const read = readTicketFiles(files, specId);
    const plan =
      !read.ok && read.parsed.tickets.length === 0
        ? undefined
        : planImport(
            read.ok ? read.input : read.parsed,
            new Map(
              repos.rows.map((row) => [
                row.name as string,
                {
                  id: row.id as number,
                  contractPath: row.contract_path as string | null,
                  reference: row.reference === true,
                },
              ]),
            ),
            specId,
            append ? await existingGraph(client, specId) : undefined,
            specRow.body as string,
            limits.projectConcurrency,
            new Set(
              repos.rows
                .filter((row) => specRefIds.has(row.id as number))
                .map((row) => row.name as string),
            ),
          );
    if (!read.ok) {
      // The files that could be read are checked as a graph too, so every problem comes back at once. What only
      // follows from a file that could not be read (a blocker that is not there) is left out.
      const graph =
        plan && !plan.ok
          ? plan.errors.filter(
              (e) => !read.failed.some((key) => e.includes(key)),
            )
          : [];
      return await rollback(client, {
        status: "invalid",
        errors: [...read.errors, ...graph],
      });
    }
    if (!plan) throw new Error("unreachable: a readable import has a plan");
    if (!plan.ok) {
      return await rollback(client, { status: "invalid", errors: plan.errors });
    }

    const idByKey = new Map<string, number>();
    const tickets: ImportedTicket[] = [];
    for (const ticket of plan.tickets) {
      const { rows } = await client.query(
        `INSERT INTO tickets (spec_id, repo_id, type, title, body, acceptance_criteria, modules, allowed_protected_paths, refs, environment, stories, appended)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          specId,
          ticket.repoId,
          ticket.type,
          ticket.title,
          ticket.body,
          ticket.acceptanceCriteria,
          ticket.modules,
          ticket.allowedProtectedPaths,
          ticket.refs,
          ticket.environment,
          ticket.stories,
          append,
        ],
      );
      const id = rows[0].id as number;
      await snapshotTicket(client, id);
      idByKey.set(ticket.key, id);
      tickets.push({
        key: ticket.key,
        id,
        displayId: formatDisplayId("ticket", id),
      });
    }
    // an end of an edge is a key of the file, or the T-<n> of a ticket the spec already had
    const idOf = (key: string): number => {
      const id = idByKey.get(key) ?? parseDisplayId(key)?.id;
      if (id === undefined)
        throw new Error(`no ticket for the edge end ${key}`);
      return id;
    };
    for (const edge of plan.edges) {
      await client.query(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $2, $3)",
        [idOf(edge.from), idOf(edge.to), edge.kind],
      );
    }

    // A plain import's warnings name tickets by the keys of the file the author just wrote. An appended file
    // mixes its keys with ids of tickets that exist, so there the warnings name tickets by the id people will see.
    const shown = (key: string) =>
      append && idByKey.has(key)
        ? formatDisplayId("ticket", idByKey.get(key) as number)
        : key;
    const warnings: ImportWarning[] = plan.warnings.map((w) => ({
      type: w.type,
      tickets: w.tickets.map(shown),
      repoId: w.repoId,
      message: w.describe(shown),
    }));
    await client.query("UPDATE specs SET import_warnings = $2 WHERE id = $1", [
      specId,
      JSON.stringify(
        append
          ? [...(specRow.import_warnings as unknown[]), ...warnings]
          : warnings,
      ),
    ]);
    if (options.planningDocsAtImport) {
      await client.query(
        "UPDATE specs SET planning_docs_at_import = $2::jsonb WHERE id = $1",
        [specId, JSON.stringify(options.planningDocsAtImport)],
      );
    }

    if (append) {
      if (specRow.state === "awaiting-review") {
        const next = specTransition("awaiting-review", "rework");
        if (!next.ok) throw new Error(next.reason);
        await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
          specId,
          next.state,
        ]);
        await client.query(
          `UPDATE finalizations SET step = 'final-review', state = 'active',
             blocked_reason = NULL, auto_retried = false, retry_note = NULL,
             job_floor = (SELECT COALESCE(max(id), 0) FROM jobs)
           WHERE spec_id = $1`,
          [specId],
        );
        const pulls = await client.query<{ id: number }>(
          "SELECT id FROM pull_requests WHERE spec_id = $1 AND state = 'open' ORDER BY id",
          [specId],
        );
        await deleteFinalE2e(client, specId);
        await stopAutoMergeJobs(client, specId, "返工中");
        for (const pull of pulls.rows)
          await enqueuePrDraft(client, { pullId: pull.id });
      }
      await ensureIntegrationBranches(
        client,
        specId,
        plan.tickets.map((t) => t.repoId),
      );
      await schedulePass(client, specId);
    }
    await client.query("COMMIT");
    return { status: "ok", tickets, warnings };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// The spec's tickets and edges as the append rules see them: cancelled tickets are named but not part of the graph.
async function existingGraph(
  client: pg.PoolClient,
  specId: number,
): Promise<ExistingGraph> {
  const rows = await client.query(
    `SELECT t.id, t.type, t.state, t.modules, t.repo_id, r.name AS repo
     FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE t.spec_id = $1 ORDER BY t.id FOR UPDATE OF t`,
    [specId],
  );
  const key = (id: number) => formatDisplayId("ticket", id);
  const alive = rows.rows.filter((t) => t.state !== "cancelled");
  const edges = await client.query(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind FROM edges e
     JOIN tickets a ON a.id = e.from_ticket_id JOIN tickets b ON b.id = e.to_ticket_id
     WHERE b.spec_id = $1 AND a.state <> 'cancelled' AND b.state <> 'cancelled' ORDER BY e.id`,
    [specId],
  );
  return {
    tickets: alive.map((t) => ({
      key: key(t.id),
      repo: t.repo,
      repoId: t.repo_id,
      type: t.type,
      state: t.state,
      modules: t.modules,
    })),
    cancelled: rows.rows
      .filter((t) => t.state === "cancelled")
      .map((t) => key(t.id)),
    edges: edges.rows.map((e) => ({
      from: key(e.from_ticket_id),
      to: key(e.to_ticket_id),
      kind: e.kind,
    })),
  };
}

async function rollback<T>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

// A bug may point at another spec in the same project. Feature and improvement cannot.
async function resolveSourceSpec(
  pool: pg.Pool,
  spec: NewSpec,
): Promise<
  | { status: "ok"; sourceSpecId: number | null }
  | { status: "invalid-source"; message: string }
> {
  if (spec.sourceSpecId === undefined) {
    return { status: "ok", sourceSpecId: null };
  }
  if (spec.type !== "bug") {
    return {
      status: "invalid-source",
      message: "only a bug spec can point at a source spec",
    };
  }
  const found = await pool.query<{ id: number; project_id: number }>(
    "SELECT id, project_id FROM specs WHERE id = $1",
    [spec.sourceSpecId],
  );
  const row = found.rows[0];
  if (!row) {
    return { status: "invalid-source", message: "no such source spec" };
  }
  if (row.project_id !== spec.projectId) {
    return {
      status: "invalid-source",
      message: "the source spec must belong to the same project",
    };
  }
  return { status: "ok", sourceSpecId: row.id };
}
