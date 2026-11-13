import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Io, run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import { listen, type RunningApi, testApp } from "../test/fake-worker.ts";

// The M1 acceptance spec's own ticket files must import as written (docs/specs/m1-acceptance/tickets/).

let db: TestDatabase;
let api: RunningApi;
beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
  // plat repo add refuses a github.com URL until a worker has reported that host
  await db.pool.query(
    "INSERT INTO code_hosts (host, kind, worker_id) VALUES ('github.com', 'github', 'w1')",
  );
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// The tracker doc a developer who ran `plat tracker-doc` for the project's first repo would have committed, so that
// these tests see no tracker doc warning on stderr.
async function committedTrackerDoc(apiUrl: string): Promise<string> {
  const project = (await (await fetch(`${apiUrl}/projects/1`)).json()) as {
    repos?: { name: string }[];
  };
  const repo = project.repos?.[0]?.name;
  if (!repo) throw new Error("ENOENT docs/agents/issue-tracker.md");
  let doc = "";
  await run(["tracker-doc", "--project", "1", "--repo", repo], {
    stdout: (text) => {
      doc += text;
    },
    stderr: () => {},
    env: { AFK_API_URL: apiUrl },
    readFile: async () => "",
    readDirectory: async () => [],
  });
  return doc;
}

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
    readFile: async (path) =>
      path === "docs/agents/issue-tracker.md"
        ? await committedTrackerDoc(api.url)
        : readFileSync(path, "utf8"),
    readDirectory: async (path) =>
      readdirSync(path).map((name) => ({
        name,
        text: readFileSync(join(path, name), "utf8"),
      })),
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

const file = fileURLToPath(
  new URL("../../../../docs/specs/m1-acceptance/tickets", import.meta.url),
);

describe("the M1 acceptance ticket files", () => {
  it("imports into the first spec: five tickets, and the overlap warnings the README promises", async () => {
    expect((await plat("project", "create", "shop")).code).toBe(0);
    expect(
      (
        await plat(
          "repo",
          "add",
          "--project",
          "1",
          "--name",
          "backend",
          "--url",
          "https://github.com/me/afk-pilot-backend.git",
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await plat(
          "repo",
          "edit",
          "backend",
          "--project",
          "1",
          "--contract-path",
          "openapi/openapi.yaml",
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
