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

const file = fileURLToPath(
  new URL("../../../../docs/specs/m1-acceptance/tickets.yaml", import.meta.url),
);

describe("the M1 acceptance ticket file", () => {
  it("imports into the first spec: five tickets, and the overlap warnings the README promises", async () => {
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
          "订单备注",
          "--slug",
          "order-note",
        )
      ).code,
    ).toBe(0);
    const imported = await plat("tickets", "import", "S-1", file);
    expect(imported.stderr).toBe("");
    expect(imported.code).toBe(0);
    const tickets = await db.pool.query(
      "SELECT title, acceptance_criteria FROM tickets ORDER BY id",
    );
    expect(tickets.rows).toHaveLength(5);
    const patch = tickets.rows.find((r) => r.title === "修改订单备注");
    expect(patch.acceptance_criteria[0]).toBe(
      'PATCH /orders/:id 请求体 { "note": "..." }，成功返回 200 和更新后的订单',
    );
    const warnings = (await db.pool.query("SELECT import_warnings FROM specs"))
      .rows[0].import_warnings as unknown[];
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
