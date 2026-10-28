import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
});
afterEach(() => db.drop());

// Postgres error code of a failing statement; "ok" when it succeeds.
async function outcome(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.pool.query(sql, params);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function insert(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query<{ id: number }>(
    `${sql} RETURNING id`,
    params,
  );
  return rows[0].id;
}

async function seed() {
  const projectId = await insert("INSERT INTO projects (name) VALUES ('p')");
  const repoId = await insert(
    "INSERT INTO repos (project_id, url, role) VALUES ($1, 'u', 'primary')",
    [projectId],
  );
  const specId = await insert(
    "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', 's', 't')",
    [projectId],
  );
  const ticket = () =>
    insert(
      "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES ($1, $2, 'implementation', 't')",
      [specId, repoId],
    );
  return { projectId, repoId, specId, ticket };
}

describe("unique constraints", () => {
  it("a job's idempotency key can be used only once", async () => {
    const sql =
      "INSERT INTO jobs (type, idempotency_key) VALUES ('agent-run', 'T-1:1:implement:1')";
    expect(await outcome(sql)).toBe("ok");
    expect(await outcome(sql)).toBe(UNIQUE_VIOLATION);
  });

  it("jobs may share a lock key (they exclude each other at claim time, not by constraint)", async () => {
    const sql =
      "INSERT INTO jobs (type, idempotency_key, lock_key) VALUES ('merge', $1, 'integration:r:spec/x')";
    expect(await outcome(sql, ["a"])).toBe("ok");
    expect(await outcome(sql, ["b"])).toBe("ok");
  });

  it("the same dependency edge cannot be recorded twice", async () => {
    const { ticket } = await seed();
    const [a, b] = [await ticket(), await ticket()];
    const sql =
      "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $2, $3)";
    expect(await outcome(sql, [a, b, "blocks"])).toBe("ok");
    expect(await outcome(sql, [a, b, "blocks"])).toBe(UNIQUE_VIOLATION);
    expect(await outcome(sql, [a, b, "contract"])).toBe("ok");
  });

  it("a ticket cannot depend on itself", async () => {
    const { ticket } = await seed();
    const a = await ticket();
    expect(
      await outcome(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $1, 'blocks')",
        [a],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("a commit has at most one gate result per repo", async () => {
    const { repoId } = await seed();
    const sql =
      "INSERT INTO gate_results (repo_id, commit_sha, config_sha) VALUES ($1, 'abc', 'cfg')";
    expect(await outcome(sql, [repoId])).toBe("ok");
    expect(await outcome(sql, [repoId])).toBe(UNIQUE_VIOLATION);
  });
});

describe("foreign keys", () => {
  const MISSING = 999999;

  it.each([
    [
      "repo -> project",
      "INSERT INTO repos (project_id, url, role) VALUES ($1, 'u', 'primary')",
    ],
    [
      "spec -> project",
      "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', 's', 't')",
    ],
    [
      "spec -> source spec",
      "INSERT INTO specs (project_id, type, slug, title, source_spec_id) VALUES (1, 'bug', 's', 't', $1)",
    ],
    [
      "ticket -> spec",
      "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES ($1, 1, 'implementation', 't')",
    ],
    [
      "ticket -> repo",
      "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES (1, $1, 'implementation', 't')",
    ],
    [
      "edge -> from ticket",
      "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, 1, 'blocks')",
    ],
    [
      "edge -> to ticket",
      "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES (1, $1, 'blocks')",
    ],
    [
      "run -> spec",
      "INSERT INTO runs (spec_id, repo_id, stage) VALUES ($1, 1, 'implement')",
    ],
    [
      "run -> repo",
      "INSERT INTO runs (spec_id, repo_id, stage) VALUES (1, $1, 'implement')",
    ],
    [
      "run -> ticket",
      "INSERT INTO runs (spec_id, repo_id, ticket_id, stage) VALUES (1, 1, $1, 'implement')",
    ],
    [
      "run -> job",
      "INSERT INTO runs (spec_id, repo_id, job_id, stage) VALUES (1, 1, $1, 'implement')",
    ],
    [
      "finding -> run",
      "INSERT INTO findings (run_id, kind, body) VALUES ($1, 'review', 'b')",
    ],
    [
      "gate result -> repo",
      "INSERT INTO gate_results (repo_id, commit_sha, config_sha) VALUES ($1, 'abc', 'cfg')",
    ],
  ])("%s must point at an existing row", async (_name, sql) => {
    const { specId } = await seed();
    expect(specId).toBe(1);
    expect(await outcome(sql, [MISSING])).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("a run outside any ticket (update-branch, final review) is allowed", async () => {
    const { specId, repoId } = await seed();
    expect(
      await outcome(
        "INSERT INTO runs (spec_id, repo_id, stage) VALUES ($1, $2, 'update-branch')",
        [specId, repoId],
      ),
    ).toBe("ok");
  });
});
