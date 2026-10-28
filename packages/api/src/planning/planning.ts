import {
  formatDisplayId,
  type ImportWarning,
  parseDisplayId,
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
}

export async function createProject(
  pool: pg.Pool,
  project: NewProject,
): Promise<{ id: number; name: string }> {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, default_agent, default_model, contract_path, protected_paths, max_concurrency, budget_limit, merge_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name`,
    [
      project.name,
      project.defaultAgent ?? null,
      project.defaultModel ?? null,
      project.contractPath ?? null,
      project.protectedPaths ?? [],
      project.maxConcurrency ?? null,
      project.budgetLimit ?? null,
      project.mergePolicy ?? null,
    ],
  );
  return rows[0];
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
      `INSERT INTO specs (project_id, type, slug, title, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
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
    );
    const named = (input as { spec?: unknown } | null)?.spec;
    if (plan.ok && named !== undefined) {
      const parsed =
        typeof named === "string" ? parseDisplayId(named) : undefined;
      if (parsed?.kind !== "spec" || parsed.id !== specId) {
        return await rollback(client, {
          status: "invalid",
          errors: [
            `spec: the file names ${String(named)}, but it is being imported into ${formatDisplayId("spec", specId)}`,
          ],
        });
      }
    }
    if (!plan.ok) {
      return await rollback(client, { status: "invalid", errors: plan.errors });
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
