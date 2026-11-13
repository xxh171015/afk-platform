import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOrThrow, gitOut, mergeTakingOurs } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/rebase-migrations.sh", import.meta.url),
);

const TRIGGER_SQL =
  "CREATE OR REPLACE FUNCTION afk_rebase_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;\n";

const sql = {
  init: "CREATE TABLE items (id integer PRIMARY KEY);\n",
  trigger: TRIGGER_SQL,
  alpha: "CREATE TABLE alpha (id integer PRIMARY KEY);\n",
  beta: "CREATE TABLE beta (id integer PRIMARY KEY);\n",
};

function drizzleJournal(tags: { tag: string; when: number }[]): string {
  return `${JSON.stringify(
    {
      version: "7",
      dialect: "postgresql",
      entries: tags.map((tag, idx) => ({
        idx,
        version: "7",
        when: tag.when,
        tag: tag.tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  )}\n`;
}

const BASE_JOURNAL = drizzleJournal([
  { tag: "0000_init", when: 1000 },
  { tag: "0001_triggers", when: 2000 },
]);

function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "packages/api/drizzle/0000_init.sql": sql.init,
    "packages/api/drizzle/0001_triggers.sql": sql.trigger,
    "packages/api/drizzle/meta/_journal.json": BASE_JOURNAL,
    "packages/api/drizzle/meta/0001_snapshot.json": '{"id":"snap"}\n',
    ...extra,
  };
}

function journalWith(...added: { tag: string; when: number }[]): string {
  return drizzleJournal([
    { tag: "0000_init", when: 1000 },
    { tag: "0001_triggers", when: 2000 },
    ...added,
  ]);
}

function read(repo: TestRepo, path: string): string {
  return readFileSync(join(repo.dir, path), "utf8");
}

function rebase(repo: TestRepo): string {
  return execFileSync("bash", [SCRIPT], {
    cwd: repo.dir,
    encoding: "utf8",
  });
}

function entriesOf(repo: TestRepo): {
  idx: number;
  tag: string;
  when: number;
}[] {
  return JSON.parse(read(repo, "packages/api/drizzle/meta/_journal.json"))
    .entries;
}

let repo: TestRepo;
let db: TestDatabase | undefined;
afterEach(async () => {
  repo?.cleanup();
  if (db) await db.drop();
  db = undefined;
});

function twoTicketRepo(kind: "distinct" | "same-path"): TestRepo {
  const built = makeRepo(baseFiles());
  git(built.dir, ["checkout", "--quiet", "-b", "spec/s"]);
  git(built.dir, ["checkout", "--quiet", "-b", "agent/A"]);
  built.commit(
    {
      "packages/api/drizzle/0002_alpha.sql": sql.alpha,
      "packages/api/drizzle/meta/_journal.json": journalWith({
        tag: "0002_alpha",
        when: 3000,
      }),
    },
    "A adds a migration",
  );
  git(built.dir, ["checkout", "--quiet", "spec/s"]);
  git(built.dir, ["checkout", "--quiet", "-b", "agent/B"]);
  if (kind === "distinct") {
    built.commit(
      {
        "packages/api/drizzle/0002_beta.sql": sql.beta,
        "packages/api/drizzle/meta/_journal.json": journalWith({
          tag: "0002_beta",
          when: 3000,
        }),
      },
      "B adds a migration",
    );
  } else {
    built.commit(
      {
        "packages/api/drizzle/0002_alpha.sql": sql.beta,
        "packages/api/drizzle/meta/_journal.json": journalWith({
          tag: "0002_alpha",
          when: 3000,
        }),
      },
      "B adds the same path",
    );
  }
  git(built.dir, ["checkout", "--quiet", "spec/s"]);
  gitOrThrow(built.dir, ["merge", "--no-edit", "--quiet", "agent/A"]);
  const oursFiles = ["packages/api/drizzle/meta/_journal.json"];
  if (kind === "same-path")
    oursFiles.push("packages/api/drizzle/0002_alpha.sql");
  const merged = mergeTakingOurs(
    built.dir,
    "spec/s",
    "agent/B",
    oursFiles,
    "merge taking ours",
  );
  gitOrThrow(built.dir, ["checkout", "--quiet", "--detach", merged.candidate]);
  return built;
}

describe("scripts/rebase-migrations.sh", () => {
  it("renumbers the incoming ticket's migrations after the integration tip, with matching journal names and a later timestamp", () => {
    repo = twoTicketRepo("distinct");
    rebase(repo);
    expect(read(repo, "packages/api/drizzle/0002_alpha.sql")).toBe(sql.alpha);
    expect(read(repo, "packages/api/drizzle/0003_beta.sql")).toBe(sql.beta);
    expect(() => read(repo, "packages/api/drizzle/0002_beta.sql")).toThrow();
    const entries = entriesOf(repo);
    expect(entries.map((e) => `${e.idx}:${e.tag}`)).toEqual([
      "0:0000_init",
      "1:0001_triggers",
      "2:0002_alpha",
      "3:0003_beta",
    ]);
    expect(entries[3]?.when).toBeGreaterThan(entries[2]?.when ?? 0);
  });

  it("keeps handwritten trigger SQL and the rebased set migrates on an empty database", async () => {
    repo = twoTicketRepo("distinct");
    const triggerBefore = read(repo, "packages/api/drizzle/0001_triggers.sql");
    rebase(repo);
    expect(read(repo, "packages/api/drizzle/0001_triggers.sql")).toBe(
      triggerBefore,
    );
    expect(read(repo, "packages/api/drizzle/0001_triggers.sql")).toBe(
      TRIGGER_SQL,
    );
    db = await createTestDatabase();
    await migrate(db.pool, join(repo.dir, "packages/api/drizzle"));
    const tables = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "alpha",
      "beta",
      "items",
    ]);
    const fn = await db.pool.query<{ n: number }>(
      "SELECT afk_rebase_probe() AS n",
    );
    expect(fn.rows[0]?.n).toBe(1);
  });

  it("changes nothing when the incoming side added no migration", () => {
    repo = makeRepo(baseFiles({ "README.md": "# repo\n" }));
    git(repo.dir, ["checkout", "--quiet", "-b", "spec/s"]);
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/B"]);
    repo.commit({ "src/only.ts": "export const x = 1;\n" }, "no drizzle");
    git(repo.dir, ["checkout", "--quiet", "spec/s"]);
    gitOrThrow(repo.dir, [
      "merge",
      "--no-ff",
      "--no-edit",
      "--quiet",
      "agent/B",
    ]);
    const before = gitOut(repo.dir, ["status", "--porcelain"]);
    const journal = read(repo, "packages/api/drizzle/meta/_journal.json");
    const snapshot = read(repo, "packages/api/drizzle/meta/0001_snapshot.json");
    rebase(repo);
    expect(gitOut(repo.dir, ["status", "--porcelain"])).toBe(before);
    expect(read(repo, "packages/api/drizzle/meta/_journal.json")).toBe(journal);
    expect(read(repo, "packages/api/drizzle/meta/0001_snapshot.json")).toBe(
      snapshot,
    );
  });

  it("recovers a same-path incoming migration that take-ours replaced with the integration blob", () => {
    repo = twoTicketRepo("same-path");
    rebase(repo);
    expect(read(repo, "packages/api/drizzle/0002_alpha.sql")).toBe(sql.alpha);
    expect(read(repo, "packages/api/drizzle/0003_alpha.sql")).toBe(sql.beta);
    const entries = entriesOf(repo);
    expect(entries.map((e) => e.tag)).toEqual([
      "0000_init",
      "0001_triggers",
      "0002_alpha",
      "0003_alpha",
    ]);
    expect(entries[3]?.when).toBeGreaterThan(entries[2]?.when ?? 0);
  });

  it("does not touch snapshot files", () => {
    repo = twoTicketRepo("distinct");
    const snapshot = read(repo, "packages/api/drizzle/meta/0001_snapshot.json");
    rebase(repo);
    expect(read(repo, "packages/api/drizzle/meta/0001_snapshot.json")).toBe(
      snapshot,
    );
  });
});
