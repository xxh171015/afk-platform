import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertMigrated, MIGRATIONS_FOLDER, migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

const ENTITY_TABLES = [
  "acceptance_packs",
  "code_hosts",
  "doctor_reports",
  "edges",
  "events",
  "final_e2e",
  "finalizations",
  "findings",
  "gate_results",
  "instance",
  "jobs",
  "links",
  "potential_conflicts",
  "projects",
  "pull_requests",
  "repos",
  "runs",
  "specs",
  "ticket_versions",
  "tickets",
  "workers",
];

// Tests that migrate "from before" leave out a migration and every one after it: drizzle skips an entry that is
// older than the newest one already applied.
function omitFrom<T extends { tag: string }>(
  entries: T[],
  startTag: string,
): T[] {
  const start = entries.findIndex((entry) => entry.tag === startTag);
  if (start < 0) throw new Error(`unknown migration ${startTag}`);
  return entries.slice(0, start);
}

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(() => db.drop());

async function tables(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("migrate", () => {
  it("creates the entity tables on an empty database", async () => {
    await migrate(db.pool);
    expect(await tables()).toEqual(ENTITY_TABLES);
  });

  it("can run again without error and without changing anything", async () => {
    await migrate(db.pool);
    await migrate(db.pool);
    expect(await tables()).toEqual(ENTITY_TABLES);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await migrate(db.pool);
    const again = await db.pool.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    expect(again.rows[0].n).toBe(rows[0].n);
  });

  it("drops the unused log_url columns", async () => {
    await migrate(db.pool);
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'log_url' AND table_name IN ('runs', 'gate_results')`,
    );
    expect(rows).toEqual([]);
  });
});

describe("the id of the database", () => {
  const idOf = async (pool: TestDatabase["pool"]) =>
    (await pool.query<{ id: string }>("SELECT id FROM instance")).rows;

  it("is made once, six hex digits, by the migration that creates it, and stays through later runs", async () => {
    await migrate(db.pool);
    const [first, ...others] = await idOf(db.pool);
    expect(others).toEqual([]);
    expect(first?.id).toMatch(/^[0-9a-f]{6}$/);
    await migrate(db.pool);
    expect(await idOf(db.pool)).toEqual([first]);
  });

  it("is not the same in two databases, so their branch names do not meet", async () => {
    const other = await createTestDatabase();
    try {
      await migrate(db.pool);
      await migrate(other.pool);
      expect(await idOf(db.pool)).not.toEqual(await idOf(other.pool));
    } finally {
      await other.drop();
    }
  });

  it("is added to a database that already has specs, and leaves them without one, so their branches keep their names", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      // the migrations as they were before this one
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = omitFrom(journal.entries, "0014_branch_namespace");
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
      await db.pool.query(
        "INSERT INTO specs (project_id, type, slug, title) VALUES (1, 'feature', 'export', 'Export')",
      );

      await migrate(db.pool);
      const specs = await db.pool.query("SELECT branch_namespace FROM specs");
      expect(specs.rows).toEqual([{ branch_namespace: null }]);
      expect(await idOf(db.pool)).toHaveLength(1);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("cannot get a second row", async () => {
    await migrate(db.pool);
    await expect(
      db.pool.query(
        "INSERT INTO instance (singleton, id) VALUES (false, 'abcdef')",
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO instance (id) VALUES ('abcdef')"),
    ).rejects.toThrow();
  });
});

describe("the contract path", () => {
  it("moves from the project to the repo it names, and the specs, tickets and repo names stay as they were", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = omitFrom(
        journal.entries,
        "0015_repo_names_and_contracts",
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query(
        "INSERT INTO projects (name, contract_path) VALUES ('shop', 'backend:openapi/openapi.yaml'), ('bare', NULL)",
      );
      await db.pool.query(
        `INSERT INTO repos (project_id, url, role) VALUES (1, 'b', 'backend'), (1, 'f', 'frontend'), (2, 'b2', 'backend')`,
      );
      await db.pool.query(
        "INSERT INTO specs (project_id, type, slug, title) VALUES (1, 'feature', 'export', 'Export')",
      );
      await db.pool.query(
        "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES (1, 2, 'implementation', 'Fe')",
      );

      await migrate(db.pool);
      const repos = await db.pool.query(
        "SELECT project_id, name, contract_path FROM repos ORDER BY id",
      );
      expect(repos.rows).toEqual([
        {
          project_id: 1,
          name: "backend",
          contract_path: "openapi/openapi.yaml",
        },
        { project_id: 1, name: "frontend", contract_path: null },
        { project_id: 2, name: "backend", contract_path: null },
      ]);
      const columns = await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'contract_path'",
      );
      expect(columns.rows).toEqual([]);
      const tickets = await db.pool.query("SELECT title, repo_id FROM tickets");
      expect(tickets.rows).toEqual([{ title: "Fe", repo_id: 2 }]);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("the contract path of a project that names no repo", () => {
  it("stops the migration rather than lose the path", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = omitFrom(
        journal.entries,
        "0015_repo_names_and_contracts",
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query(
        "INSERT INTO projects (name, contract_path) VALUES ('shop', 'gone:openapi.yaml')",
      );
      await db.pool.query(
        "INSERT INTO repos (project_id, url, role) VALUES (1, 'b', 'backend')",
      );
      await expect(migrate(db.pool)).rejects.toThrow();
      const columns = await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'contract_path'",
      );
      expect(columns.rows).toHaveLength(1);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("migrating ticket bodies to the issue template", () => {
  // The database as it was before 0026, with a project, a repo and a spec.
  async function before0026(): Promise<string> {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = omitFrom(journal.entries, "0026_ticket_template_bodies");
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db.pool, before);
    await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
    await db.pool.query(
      "INSERT INTO repos (project_id, url, name) VALUES (1, 'b', 'backend')",
    );
    await db.pool.query(
      "INSERT INTO specs (project_id, type, slug, title, body) VALUES (1, 'feature', 'export', 'Export', E'# spec\\n')",
    );
    return before;
  }
  const addTicket = (body: string, criteria: string[], version = 1) =>
    db.pool.query(
      `INSERT INTO tickets (spec_id, repo_id, type, title, body, acceptance_criteria, content_version)
       VALUES (1, 1, 'implementation', 'T', $1, $2, $3)`,
      [body, criteria, version],
    );

  it("rewrites every ticket and every kept version, keeps the old body under What to build, and changes no version or spec", async () => {
    const before = await before0026();
    try {
      await addTicket("Old details.\n", ["it works", "is fast"], 2);
      await db.pool.query(
        `INSERT INTO ticket_versions (ticket_id, version, title, body, acceptance_criteria, modules, allowed_protected_paths)
         VALUES (1, 1, 'T', 'First details', ARRAY['it works'], ARRAY['**'], ARRAY[]::text[]),
                (1, 2, 'T', 'Old details.', ARRAY['it works', 'is fast'], ARRAY['**'], ARRAY[]::text[])`,
      );
      await migrate(db.pool);

      const ticket = await db.pool.query(
        "SELECT body, acceptance_criteria, content_version FROM tickets",
      );
      expect(ticket.rows[0]).toEqual({
        body: "## Parent\n\nS-1\n\n## What to build\n\nOld details.\n\n## Acceptance criteria\n\n- [ ] it works\n- [ ] is fast\n",
        acceptance_criteria: ["it works", "is fast"],
        content_version: 2,
      });
      const versions = await db.pool.query(
        "SELECT version, body FROM ticket_versions ORDER BY version",
      );
      expect(versions.rows).toEqual([
        {
          version: 1,
          body: "## Parent\n\nS-1\n\n## What to build\n\nFirst details\n\n## Acceptance criteria\n\n- [ ] it works\n",
        },
        { version: 2, body: ticket.rows[0].body },
      ]);
      expect((await db.pool.query("SELECT body FROM specs")).rows[0].body).toBe(
        "# spec\n",
      );
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("stops the whole migration and names the ticket when its criteria do not read back", async () => {
    const before = await before0026();
    try {
      await addTicket("fine", ["ok"]);
      await addTicket("two\nlines", ["first\nsecond"]);
      await expect(migrate(db.pool)).rejects.toThrow(/T-2 \(version 1\)/);
      const bodies = await db.pool.query(
        "SELECT body FROM tickets ORDER BY id",
      );
      expect(bodies.rows.map((r) => r.body)).toEqual(["fine", "two\nlines"]);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("refuses an old body that would swallow or repeat the template's sections", async () => {
    const before = await before0026();
    try {
      await addTicket("```\nnever closed", ["ok"]);
      await expect(migrate(db.pool)).rejects.toThrow(/unclosed code fence/);
      await db.pool.query("DELETE FROM tickets");
      await addTicket("## Acceptance criteria\n\n- [ ] other", ["ok"]);
      await expect(migrate(db.pool)).rejects.toThrow(/T-\d+ \(version 1\)/);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("assertMigrated", () => {
  it("refuses to start on a database that was never migrated, and says which command to run", async () => {
    await expect(assertMigrated(db.pool)).rejects.toThrow(/pnpm db:migrate/);
  });

  it("passes once every migration has run", async () => {
    await migrate(db.pool);
    await expect(assertMigrated(db.pool)).resolves.toBeUndefined();
  });

  it("refuses again when a newer migration file has not run yet", async () => {
    await migrate(db.pool);
    const folder = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      writeFileSync(
        join(folder, "9999_extra.sql"),
        "CREATE TABLE extra_table (id integer);\n",
      );
      const journalPath = join(folder, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries.push({
        idx: journal.entries.length,
        version: "7",
        when: journal.entries.at(-1).when + 1000,
        tag: "9999_extra",
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      await expect(assertMigrated(db.pool, folder)).rejects.toThrow(
        /9999_extra/,
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the host kind of a repo", () => {
  it("is read once from the address of the repos that exist, and later ones are checked", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = omitFrom(journal.entries, "0029_repo_host_kind");
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
      await db.pool.query(
        `INSERT INTO repos (project_id, url, name) VALUES
           (1, 'https://github.com/acme/a.git', 'a'),
           (1, 'git@gitlab.example.org:acme/b.git', 'b'),
           (1, 'https://git.example.org/acme/c.git', 'c')`,
      );

      await migrate(db.pool);
      const repos = await db.pool.query(
        "SELECT name, host_kind FROM repos ORDER BY id",
      );
      expect(repos.rows).toEqual([
        { name: "a", host_kind: "github" },
        { name: "b", host_kind: "gitlab" },
        { name: "c", host_kind: "github" },
      ]);
      await expect(
        db.pool.query("UPDATE repos SET host_kind = 'gitea'"),
      ).rejects.toThrow(/repos_host_kind_check/);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("one host-sync job per project", () => {
  it("drops the old chain of looks, leaves other jobs, and queues one look where a pull request is still followed", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { tag: string }) => Number(e.tag.slice(0, 4)) < 38,
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query(
        "INSERT INTO projects (name) VALUES ('shop'), ('other')",
      );
      await db.pool.query(
        `INSERT INTO repos (project_id, url, name) VALUES
           (1, 'https://github.com/me/shop.git', 'backend'),
           (2, 'https://github.com/me/other.git', 'backend')`,
      );
      await db.pool.query(
        `INSERT INTO specs (project_id, type, slug, title, state) VALUES
           (1, 'feature', 'export', 'Export', 'awaiting-review'),
           (2, 'feature', 'done', 'Done', 'merged')`,
      );
      await db.pool.query(
        `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha) VALUES
           (1, 1, 7, 'https://github.com/me/shop/pull/7', 'open', 'abc'),
           (2, 2, 8, 'https://github.com/me/other/pull/8', 'merged', 'def')`,
      );
      await db.pool.query(
        `INSERT INTO jobs (type, payload, state, idempotency_key) VALUES
           ('host-sync', $1::jsonb, 'done', 'project-1:host-sync:1'),
           ('host-sync', $1::jsonb, 'done', 'project-1:host-sync:2'),
           ('host-sync', $1::jsonb, 'queued', 'project-1:host-sync:3'),
           ('host-sync', $2::jsonb, 'done', 'project-2:host-sync:1'),
           ('open-pr', $3::jsonb, 'queued', 'S-1:repo-1:open-pr:1')`,
        [
          JSON.stringify({ projectId: 1 }),
          JSON.stringify({ projectId: 2 }),
          JSON.stringify({ specId: 1, repoId: 1 }),
        ],
      );

      await migrate(db.pool);
      expect(
        (
          await db.pool.query(
            "SELECT state, payload, idempotency_key FROM jobs WHERE type = 'host-sync' ORDER BY id",
          )
        ).rows,
      ).toEqual([
        {
          state: "queued",
          payload: { projectId: 1 },
          idempotency_key: "project-1:host-sync",
        },
      ]);
      expect(
        (
          await db.pool.query(
            "SELECT type, idempotency_key FROM jobs WHERE type <> 'host-sync'",
          )
        ).rows,
      ).toEqual([{ type: "open-pr", idempotency_key: "S-1:repo-1:open-pr:1" }]);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("pause reasons as codes", () => {
  it("turns the old free-text pause reason into budget-exhausted and rejects anything else", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { tag: string }) => Number(e.tag.slice(0, 4)) < 41,
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);
      await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
      await db.pool.query(
        `INSERT INTO specs (project_id, type, slug, title, state, pause_reason) VALUES
           (1, 'feature', 'out', 'Out', 'paused', 'the agent time limit of the spec was reached'),
           (1, 'feature', 'gate', 'Gate', 'paused', 'update-branch-gate-failed'),
           (1, 'feature', 'run', 'Run', 'running', NULL)`,
      );

      await migrate(db.pool);
      expect(
        (
          await db.pool.query(
            "SELECT slug, pause_reason FROM specs ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { slug: "out", pause_reason: "budget-exhausted" },
        { slug: "gate", pause_reason: "update-branch-gate-failed" },
        { slug: "run", pause_reason: null },
      ]);
      await expect(
        db.pool.query(
          "UPDATE specs SET pause_reason = 'the agent time limit of the spec was reached' WHERE slug = 'out'",
        ),
      ).rejects.toThrow(/specs_pause_reason_check/);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});

describe("final-fix findings already on disk", () => {
  it("marks wrap-up must-fix as fixed when that repo's final-fix is done, and leaves the rest", async () => {
    const before = mkdtempSync(join(tmpdir(), "afk-migrations-"));
    try {
      cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = omitFrom(journal.entries, "0050_final_fix_findings");
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(db.pool, before);

      await db.pool.query("INSERT INTO projects (name) VALUES ('shop')");
      await db.pool.query(
        `INSERT INTO repos (project_id, url, name) VALUES
           (1, 'git@x:backend', 'backend'),
           (1, 'git@x:frontend', 'frontend')`,
      );
      await db.pool.query(
        `INSERT INTO specs (project_id, type, slug, title) VALUES
           (1, 'feature', 'done-fix', 'Done'),
           (1, 'feature', 'failed-fix', 'Failed')`,
      );
      await db.pool.query(
        "INSERT INTO tickets (spec_id, repo_id, type, title) VALUES (1, 1, 'implementation', 'A')",
      );
      await db.pool.query(
        `INSERT INTO runs (spec_id, repo_id, ticket_id, stage, result) VALUES
           (1, 1, 1, 'review', 'pass'),
           (1, 1, NULL, 'final-review', 'fix'),
           (1, 1, NULL, 'final-fix', 'done'),
           (1, 2, NULL, 'final-review', 'fix'),
           (2, 1, NULL, 'final-review', 'fix'),
           (2, 1, NULL, 'final-fix', 'agent-gave-up')`,
      );
      await db.pool.query(
        `INSERT INTO findings (run_id, kind, body, resolution) VALUES
           (1, 'must-fix', 'ticket leftover', 'unhandled'),
           (2, 'must-fix', 'backend must-fix', 'unhandled'),
           (2, 'suggestion', 'backend suggestion', 'acceptance-pack'),
           (4, 'must-fix', 'frontend must-fix', 'unhandled'),
           (5, 'must-fix', 'failed-spec must-fix', 'unhandled')`,
      );

      await migrate(db.pool);
      expect(
        (
          await db.pool.query(
            "SELECT body, resolution FROM findings ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { body: "ticket leftover", resolution: "unhandled" },
        { body: "backend must-fix", resolution: "fixed" },
        { body: "backend suggestion", resolution: "acceptance-pack" },
        { body: "frontend must-fix", resolution: "unhandled" },
        { body: "failed-spec must-fix", resolution: "unhandled" },
      ]);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});
