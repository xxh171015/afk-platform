import {
  formatDisplayId,
  type ImportWarning,
  type LimitOverrides,
  planImport,
  type SPEC_TYPES,
} from "@afk/shared";
import type pg from "pg";

// Registering projects, repos and specs, and importing a spec's whole ticket graph
// (docs/specs/m1-platform.md「plat CLI」, docs/design.md「导入格式」).

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === UNIQUE_VIOLATION;

export interface NewProject {
  name: string;
  defaultAgent?: string;
  defaultModel?: string;
  contractPath?: string;
  protectedPaths?: string[];
  maxConcurrency?: number;
  budgetLimit?: number;
  mergePolicy?: string;
  limits?: LimitOverrides;
}

export async function createProject(
  pool: pg.Pool,
  project: NewProject,
): Promise<{ id: number; name: string }> {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, default_agent, default_model, contract_path, protected_paths, max_concurrency, budget_limit, merge_policy, limits)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name`,
    [
      project.name,
      project.defaultAgent ?? null,
      project.defaultModel ?? null,
      project.contractPath ?? null,
      project.protectedPaths ?? [],
      project.maxConcurrency ?? null,
      project.budgetLimit ?? null,
      project.mergePolicy ?? null,
      JSON.stringify(project.limits ?? {}),
    ],
  );
  return rows[0];
}

export type ProjectEdit = Partial<
  Pick<
    NewProject,
    | "defaultModel"
    | "contractPath"
    | "protectedPaths"
    | "maxConcurrency"
    | "budgetLimit"
    | "limits"
  >
>;

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
  if (edit.defaultModel !== undefined) set("default_model", edit.defaultModel);
  if (edit.contractPath !== undefined) set("contract_path", edit.contractPath);
  if (edit.protectedPaths !== undefined)
    set("protected_paths", edit.protectedPaths);
  if (edit.maxConcurrency !== undefined)
    set("max_concurrency", edit.maxConcurrency);
  if (edit.budgetLimit !== undefined) set("budget_limit", edit.budgetLimit);
  if (edit.limits !== undefined)
    set("limits", JSON.stringify(edit.limits), "limits || $::jsonb");
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
  role: string;
  defaultBranch?: string;
}

export type AddRepoResult =
  | { status: "ok"; repo: { id: number; role: string } }
  | { status: "no-project" }
  | { status: "role-taken" };

export async function addRepo(
  pool: pg.Pool,
  repo: NewRepo,
): Promise<AddRepoResult> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    repo.projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  try {
    const { rows } = await pool.query(
      `INSERT INTO repos (project_id, url, default_branch, role) VALUES ($1, $2, COALESCE($3, 'main'), $4)
       RETURNING id, role`,
      [repo.projectId, repo.url, repo.defaultBranch ?? null, repo.role],
    );
    return { status: "ok", repo: rows[0] };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "role-taken" };
    throw error;
  }
}

export interface NewSpec {
  projectId: number;
  type: (typeof SPEC_TYPES)[number];
  slug: string;
  title: string;
  body?: string;
}

export type CreateSpecResult =
  | { status: "ok"; spec: { id: number; displayId: string } }
  | { status: "no-project" }
  | { status: "slug-taken" };

export async function createSpec(
  pool: pg.Pool,
  spec: NewSpec,
): Promise<CreateSpecResult> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    spec.projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  try {
    const { rows } = await pool.query(
      `INSERT INTO specs (project_id, type, slug, title, body, branch_namespace)
       SELECT $1, $2, $3, $4, $5, id FROM instance RETURNING id`,
      [spec.projectId, spec.type, spec.slug, spec.title, spec.body ?? ""],
    );
    const id = rows[0].id as number;
    return {
      status: "ok",
      spec: { id, displayId: formatDisplayId("spec", id) },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "slug-taken" };
    throw error;
  }
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

// All or nothing: the file is validated first, then written in one transaction. The spec row is locked, so
// two imports of the same spec cannot both pass the "no tickets yet" check.
export async function importTickets(
  pool: pg.Pool,
  specId: number,
  input: unknown,
): Promise<ImportResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const spec = await client.query(
      "SELECT project_id, state FROM specs WHERE id = $1 FOR UPDATE",
      [specId],
    );
    if (spec.rowCount === 0)
      return await rollback(client, { status: "no-spec" });
    if (spec.rows[0].state !== "draft") {
      return await rollback(client, {
        status: "not-importable",
        message: `${formatDisplayId("spec", specId)} is ${spec.rows[0].state}; tickets can only be imported while it is a draft`,
      });
    }
    const existing = await client.query(
      "SELECT 1 FROM tickets WHERE spec_id = $1 LIMIT 1",
      [specId],
    );
    if (existing.rowCount !== 0) {
      return await rollback(client, {
        status: "not-importable",
        message: `${formatDisplayId("spec", specId)} already has tickets; the import is all at once`,
      });
    }

    const repos = await client.query(
      "SELECT role, id FROM repos WHERE project_id = $1",
      [spec.rows[0].project_id],
    );
    const plan = planImport(
      input,
      new Map(repos.rows.map((row) => [row.role as string, row.id as number])),
      specId,
    );
    if (!plan.ok) {
      return await rollback(client, { status: "invalid", errors: plan.errors });
    }

    // A contract edge hands the pinned contract to the downstream ticket, which needs a path to find it by.
    if (plan.edges.some((edge) => edge.kind === "contract")) {
      const project = await client.query(
        "SELECT contract_path FROM projects WHERE id = $1",
        [spec.rows[0].project_id],
      );
      if (!project.rows[0]?.contract_path) {
        return await rollback(client, {
          status: "invalid",
          errors: [
            "the tickets have a contract edge, but the project has no contract path; set it with --contract-path <role>:<path> (e.g. backend:openapi/openapi.yaml) on plat project create, or on plat project edit for an existing project",
          ],
        });
      }
    }

    const idByKey = new Map<string, number>();
    const tickets: ImportedTicket[] = [];
    for (const ticket of plan.tickets) {
      const { rows } = await client.query(
        `INSERT INTO tickets (spec_id, repo_id, type, title, body, acceptance_criteria, modules, allowed_protected_paths)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          specId,
          ticket.repoId,
          ticket.type,
          ticket.title,
          ticket.body,
          ticket.acceptanceCriteria,
          ticket.modules,
          ticket.allowedProtectedPaths,
        ],
      );
      const id = rows[0].id as number;
      idByKey.set(ticket.key, id);
      tickets.push({
        key: ticket.key,
        id,
        displayId: formatDisplayId("ticket", id),
      });
    }
    for (const edge of plan.edges) {
      await client.query(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $2, $3)",
        [idByKey.get(edge.from), idByKey.get(edge.to), edge.kind],
      );
    }
    await client.query("UPDATE specs SET import_warnings = $2 WHERE id = $1", [
      specId,
      JSON.stringify(plan.warnings),
    ]);
    await client.query("COMMIT");
    return { status: "ok", tickets, warnings: plan.warnings };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback<T>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}
