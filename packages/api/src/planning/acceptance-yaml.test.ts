import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Io, run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi } from "../test/fake-worker.ts";

// The M1 acceptance spec's own ticket file must import as written (docs/specs/m1-acceptance/tickets.yaml).

let db: TestDatabase;
let api: RunningApi;
beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(createApp({ pool: db.pool }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

async function plat(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { AFK_API_URL: api.url },
    readFile: async (path) => readFileSync(path, "utf8"),
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

function ticketFile(dir: string) {
  return fileURLToPath(
    new URL(`../../../../docs/specs/${dir}/tickets.yaml`, import.meta.url),
  );
}

// Project, backend repo and a draft spec S-1, then the import; returns what it printed.
async function importIntoFirstSpec(dir: string, title: string, slug: string) {
  expect(
    (
      await plat(
        "project",
        "create",
        "shop",
        "--contract-path",
        "backend:openapi/openapi.yaml",
      )
    ).code,
  ).toBe(0);
  expect(
    (
      await plat(
        "repo",
        "add",
        "--project",
        "1",
        "--role",
        "backend",
        "--url",
        "https://github.com/me/afk-pilot-backend.git",
      )
    ).code,
  ).toBe(0);
  expect(
    (
      await plat(
        "spec",
        "create",
        "--project",
        "1",
        "--type",
        "feature",
        "--title",
        title,
        "--slug",
        slug,
      )
    ).code,
  ).toBe(0);
  const imported = await plat("tickets", "import", "S-1", ticketFile(dir));
  expect(imported.stderr).toBe("");
  expect(imported.code).toBe(0);
  return imported.stdout;
}

async function importWarnings() {
  return (await db.pool.query("SELECT import_warnings FROM specs")).rows[0]
    .import_warnings as unknown[];
}

describe("the M1 acceptance ticket files", () => {
  it("m1-acceptance imports into the first spec: five tickets, and the overlap warnings the README promises", async () => {
    await importIntoFirstSpec("m1-acceptance", "订单备注", "order-note");
    const tickets = await db.pool.query(
      "SELECT title, acceptance_criteria FROM tickets ORDER BY id",
    );
    expect(tickets.rows).toHaveLength(5);
    const patch = tickets.rows.find((r) => r.title === "修改订单备注");
    expect(patch.acceptance_criteria[0]).toBe(
      'PATCH /orders/:id 请求体 { "note": "..." }，成功返回 200 和更新后的订单',
    );
    expect((await importWarnings()).length).toBeGreaterThanOrEqual(2);
  });

  it("m1-acceptance-2 imports into the first spec: five tickets, the contract edge, and the overlap warnings its README promises", async () => {
    const stdout = await importIntoFirstSpec(
      "m1-acceptance-2",
      "订单状态历史",
      "order-history",
    );
    const tickets = await db.pool.query(
      "SELECT title FROM tickets ORDER BY id",
    );
    expect(tickets.rows).toHaveLength(5);
    const edges = await db.pool.query("SELECT kind FROM edges");
    expect(edges.rows.map((r) => r.kind).sort()).toContain("contract");
    // pagination overlaps the other three implementation tickets; history-endpoint overlaps stats-last-updated
    expect(await importWarnings()).toHaveLength(4);
    expect(stdout.match(/^warning: /gm)).toHaveLength(4);
  });
});
