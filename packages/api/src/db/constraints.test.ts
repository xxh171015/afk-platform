import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedTestDatabase, type TestDatabase } from "./test-db.ts";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

let db: TestDatabase;
beforeEach(async () => {
  db = await createMigratedTestDatabase();
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
    "INSERT INTO repos (project_id, url, name) VALUES ($1, 'u', 'primary')",
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
      "INSERT INTO repos (project_id, url, name) VALUES ($1, 'u', 'primary')",
    ],
    [
      "spec -> project",
      "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', 's', 't')",
    ],
    [
      "spec -> source spec",
      "INSERT INTO specs (project_id, type, slug, title, source_spec_id) VALUES (1, 'bug', 'other', 't', $1)",
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

describe("closed vocabularies (mirrors @afk/shared)", () => {
  async function ticketWith(
    columns: string,
    value: string,
    extra = "",
  ): Promise<string> {
    const { specId, repoId } = await seed();
    return outcome(
      `INSERT INTO tickets (spec_id, repo_id, type, title, ${columns}) VALUES ($1, $2, 'implementation', 't', ${value})${extra}`,
      [specId, repoId],
    );
  }

  it("a ticket's state must be one of the ticket states", async () => {
    expect(await ticketWith("state", "'queued'")).toBe("ok");
    expect(await ticketWith("state", "'paused'")).toBe(CHECK_VIOLATION);
  });

  it("a ticket's type must be a known type", async () => {
    const { specId, repoId } = await seed();
    const sql =
      "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES ($1, $2, $3, 't')";
    expect(await outcome(sql, [specId, repoId, "contract"])).toBe("ok");
    expect(await outcome(sql, [specId, repoId, "chore"])).toBe(CHECK_VIOLATION);
  });

  it("a blocked ticket must carry a known reason, and only a blocked ticket may", async () => {
    expect(
      await ticketWith("state, blocked_reason", "'blocked', 'gate-failed'"),
    ).toBe("ok");
    expect(
      await ticketWith("state, blocked_reason", "'blocked', 'sandbox-oom'"),
    ).toBe("ok");
    expect(
      await ticketWith("state, blocked_reason", "'blocked', 'branch-moved'"),
    ).toBe("ok");
    expect(await ticketWith("state", "'blocked'")).toBe(CHECK_VIOLATION);
    expect(await ticketWith("state, blocked_reason", "'blocked', 'oops'")).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await ticketWith("state, blocked_reason", "'pending', 'gate-failed'"),
    ).toBe(CHECK_VIOLATION);
  });

  it("a blocked overall review step and a blocked final e2e must carry a known reason code", async () => {
    const { specId, repoId } = await seed();
    const finalization = await insert(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, $2)",
      [specId, repoId],
    );
    const block = (reason: string) =>
      outcome(
        "UPDATE finalizations SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
        [finalization, reason],
      );
    expect(await block("the review went wrong")).toBe(CHECK_VIOLATION);
    expect(await block("merge-conflict")).toBe("ok");
    expect(await block("sandbox-oom")).toBe("ok");
    expect(await block("branch-moved")).toBe("ok");

    const e2e = await insert("INSERT INTO final_e2e (spec_id) VALUES ($1)", [
      specId,
    ]);
    const blockE2e = (reason: string) =>
      outcome(
        "UPDATE final_e2e SET state = 'blocked', blocked_reason = $2 WHERE id = $1",
        [e2e, reason],
      );
    expect(await blockE2e("gate-failed")).toBe(CHECK_VIOLATION);
    expect(await blockE2e("final-e2e-failed")).toBe("ok");
    expect(await blockE2e("job-failed")).toBe("ok");
    expect(await blockE2e("sandbox-oom")).toBe("ok");
  });

  it("a paused spec must carry a known pause reason, and only a paused spec may", async () => {
    const { specId } = await seed();
    expect(
      await outcome("UPDATE specs SET state = 'paused' WHERE id = $1", [
        specId,
      ]),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        "UPDATE specs SET state = 'paused', pause_reason = 'oops' WHERE id = $1",
        [specId],
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      ),
    ).toBe("ok");
    expect(
      await outcome(
        "UPDATE specs SET pause_reason = 'branch-moved' WHERE id = $1",
        [specId],
      ),
    ).toBe("ok");
    expect(
      await outcome(
        "UPDATE specs SET pause_reason = 'job-failed' WHERE id = $1",
        [specId],
      ),
    ).toBe("ok");
    expect(
      await outcome(
        "UPDATE specs SET pause_reason = 'update-branch-conflict' WHERE id = $1",
        [specId],
      ),
    ).toBe("ok");
    expect(
      await outcome(
        "UPDATE specs SET state = 'running', pause_reason = 'budget-exhausted' WHERE id = $1",
        [specId],
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        "UPDATE specs SET state = 'running', pause_reason = NULL WHERE id = $1",
        [specId],
      ),
    ).toBe("ok");
  });

  it("only a bug may point at a source spec, which must be another spec in the same project", async () => {
    const { projectId, specId } = await seed();
    expect(
      await outcome(
        "INSERT INTO specs (project_id, type, slug, title, source_spec_id) VALUES ($1, 'feature', 'from-feature', 't', $2)",
        [projectId, specId],
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        "INSERT INTO specs (project_id, type, slug, title, source_spec_id) VALUES ($1, 'bug', 'from-feature', 't', $2)",
        [projectId, specId],
      ),
    ).toBe("ok");
    const bugId = await insert(
      "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'bug', 'self', 't')",
      [projectId],
    );
    expect(
      await outcome("UPDATE specs SET source_spec_id = $1 WHERE id = $1", [
        bugId,
      ]),
    ).toBe(CHECK_VIOLATION);
    const other = await insert("INSERT INTO projects (name) VALUES ('other')");
    expect(
      await outcome(
        "INSERT INTO specs (project_id, type, slug, title, source_spec_id) VALUES ($1, 'bug', 'cross', 't', $2)",
        [other, specId],
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("a spec's type and state must be known values", async () => {
    const { projectId } = await seed();
    const sql =
      "INSERT INTO specs (project_id, type, slug, title, state) VALUES ($1, $2, md5(random()::text), 't', $3)";
    expect(await outcome(sql, [projectId, "bug", "partially-merged"])).toBe(
      "ok",
    );
    expect(await outcome(sql, [projectId, "epic", "draft"])).toBe(
      CHECK_VIOLATION,
    );
    expect(await outcome(sql, [projectId, "feature", "blocked"])).toBe(
      CHECK_VIOLATION,
    );
  });

  it("a repo role and a spec slug are unique within a project", async () => {
    const { projectId } = await seed();
    expect(
      await outcome(
        "INSERT INTO repos (project_id, url, name) VALUES ($1, 'other', 'primary')",
        [projectId],
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await outcome(
        "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', 's', 'again')",
        [projectId],
      ),
    ).toBe(UNIQUE_VIOLATION);
    const other = await db.pool.query(
      "INSERT INTO projects (name) VALUES ('other') RETURNING id",
    );
    expect(
      await outcome(
        "INSERT INTO specs (project_id, type, slug, title) VALUES ($1, 'feature', 's', 'again')",
        [other.rows[0].id],
      ),
    ).toBe("ok");
  });

  it("an edge's kind must be blocks or contract", async () => {
    const { ticket } = await seed();
    const [a, b] = [await ticket(), await ticket()];
    expect(
      await outcome(
        "INSERT INTO edges (from_ticket_id, to_ticket_id, kind) VALUES ($1, $2, 'relates')",
        [a, b],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("a job's state must be one of the four job states", async () => {
    const sql =
      "INSERT INTO jobs (type, idempotency_key, state) VALUES ('agent-run', $1, $2)";
    expect(await outcome(sql, ["a", "running"])).toBe("ok");
    expect(await outcome(sql, ["b", "weird"])).toBe(CHECK_VIOLATION);
  });
});
