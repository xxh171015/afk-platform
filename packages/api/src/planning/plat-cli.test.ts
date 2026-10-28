import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Io, run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";

// The plat commands against the real HTTP API and a real Postgres.

let db: TestDatabase;
let api: RunningApi;
let files: Record<string, string>;
let logDir: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  logDir = await mkdtemp(join(tmpdir(), "afk-logs-"));
  api = await listen(createApp({ pool: db.pool, logDir }));
  files = {};
});
afterEach(async () => {
  await api.close();
  await db.drop();
  await rm(logDir, { recursive: true, force: true });
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
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

const TICKETS_YAML = `
spec: S-1
tickets:
  - key: contract
    repo: backend
    type: contract
    title: Define the export endpoint
    modules: ["openapi/**"]
    protected_paths_ok: ["openapi/openapi.yaml"]
    acceptance:
      - openapi.yaml has GET /orders/export
    body: |
      details
  - key: be
    repo: backend
    type: implementation
    title: Implement the export
    modules: ["src/orders/**"]
    blocked_by: [contract]
    acceptance: [returns CSV]
  - key: be2
    repo: backend
    type: implementation
    title: Export filters
    modules: ["src/orders/filters.ts"]
    blocked_by: [contract]
    acceptance: [filters by customer]
  - key: fe
    repo: frontend
    type: implementation
    title: Export button
    modules: ["src/pages/orders/**"]
    contract: contract
    acceptance: [button downloads the file]
external_blocked_by: []
`;

async function register() {
  await plat("project", "create", "shop");
  await plat(
    "repo",
    "add",
    "--project",
    "1",
    "--role",
    "backend",
    "--url",
    "git@github.com:acme/backend.git",
  );
  await plat(
    "repo",
    "add",
    "--project",
    "1",
    "--role",
    "frontend",
    "--url",
    "git@github.com:acme/frontend.git",
  );
  files["spec.md"] = "# Order export\n";
  return plat(
    "spec",
    "create",
    "--project",
    "1",
    "--type",
    "feature",
    "--title",
    "Order export",
    "--file",
    "spec.md",
  );
}

describe("plat", () => {
  it("walks project create, repo add, spec create and tickets import", async () => {
    const spec = await register();
    expect(spec).toEqual({ code: 0, stdout: "S-1\n", stderr: "" });
    const stored = await db.pool.query("SELECT slug, body FROM specs");
    expect(stored.rows[0]).toEqual({
      slug: "order-export",
      body: "# Order export\n",
    });

    files["tickets.yaml"] = TICKETS_YAML;
    const imported = await plat("tickets", "import", "S-1", "tickets.yaml");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("imported 4 tickets into S-1");
    expect(imported.stdout).toContain("T-1  contract");
    expect(imported.stdout).toContain("warning: tickets be and be2");
    expect(
      Number((await db.pool.query("SELECT count(*) FROM edges")).rows[0].count),
    ).toBe(3);
  });

  it("confirms the split and says what was queued", async () => {
    await register();
    files["tickets.yaml"] = TICKETS_YAML;
    await plat("tickets", "import", "S-1", "tickets.yaml");
    const confirmed = await plat("spec", "confirm", "S-1");
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toContain("S-1 is running");
    expect(confirmed.stdout).toContain("queued T-1");
    expect(confirmed.stdout).toContain("spec/order-export");
    const again = await plat("spec", "confirm", "S-1");
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/not allowed in running/);
    expect((await plat("spec", "confirm", "T-1")).stderr).toMatch(
      /not a spec id/,
    );
  });

  it("passes --limit overrides to the project", async () => {
    await plat(
      "project",
      "create",
      "tuned",
      "--limit",
      "repoConcurrency=3",
      "--limit",
      "specAgentSeconds=60",
    );
    const row = await db.pool.query("SELECT limits FROM projects");
    expect(row.rows[0].limits).toEqual({
      repoConcurrency: 3,
      specAgentSeconds: 60,
    });
    expect(
      (await plat("project", "create", "bad", "--limit", "oops")).stderr,
    ).toMatch(/name=positive integer/);
    expect(
      (await plat("project", "create", "bad", "--limit", "nope=1")).code,
    ).toBe(1);
  });

  it("prints a run's log, all of it or from an offset, as text or JSON", async () => {
    await register();
    files["tickets.yaml"] = TICKETS_YAML;
    await plat("tickets", "import", "S-1", "tickets.yaml");
    await plat("spec", "confirm", "S-1");
    const worker = new FakeWorker(api.url, "w1", []);
    const job = (await worker.claim()).body.job;
    const runId = (
      await db.pool.query("SELECT id FROM runs WHERE job_id = $1", [job?.id])
    ).rows[0].id;
    for (const chunk of ["line one\n", "línea dos\n", "line three\n"]) {
      await fetch(`${api.url}/worker/runs/${runId}/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "w1", attempt: job?.attempt, chunk }),
      });
    }
    const text = await plat("run", "logs", `R-${runId}`);
    expect(text).toEqual({
      code: 0,
      stdout: "line one\nlínea dos\nline three\n",
      stderr: "",
    });

    const fromOffset = await plat("run", "logs", `R-${runId}`, "--from", "9");
    expect(fromOffset.stdout).toBe("línea dos\nline three\n");

    const asJson = JSON.parse(
      (await plat("--json", "run", "logs", `R-${runId}`)).stdout,
    );
    expect(asJson).toMatchObject({
      run: `R-${runId}`,
      attempt: 1,
      finished: false,
      text: "line one\nlínea dos\nline three\n",
    });

    // a log longer than one page is read to the end
    const big = "x".repeat(600 * 1024);
    await fetch(`${api.url}/worker/runs/${runId}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "w1",
        attempt: job?.attempt,
        chunk: big,
      }),
    });
    expect((await plat("run", "logs", `R-${runId}`)).stdout.length).toBe(
      "line one\nlínea dos\nline three\n".length + big.length,
    );

    expect((await plat("run", "logs", "R-999")).stderr).toMatch(/no such run/);
    expect((await plat("run", "logs", "T-1")).stderr).toMatch(/not a run id/);
    expect((await plat("run", "logs", `R-${runId}`, "--from", "-1")).code).toBe(
      1,
    );
  });

  it("prints one JSON document with --json", async () => {
    await register();
    files["tickets.yaml"] = TICKETS_YAML;
    const imported = await plat(
      "--json",
      "tickets",
      "import",
      "S-1",
      "tickets.yaml",
    );
    const body = JSON.parse(imported.stdout);
    expect(body.tickets.map((t: { displayId: string }) => t.displayId)).toEqual(
      ["T-1", "T-2", "T-3", "T-4"],
    );
    expect(body.warnings).toHaveLength(1);

    const project = await plat(
      "--json",
      "project",
      "create",
      "second",
      "--max-concurrency",
      "3",
      "--protected-path",
      "a/**",
      "--protected-path",
      "b/**",
    );
    expect(JSON.parse(project.stdout)).toEqual({ id: 2, name: "second" });
    const row = await db.pool.query(
      "SELECT protected_paths, max_concurrency FROM projects WHERE id = 2",
    );
    expect(row.rows[0]).toEqual({
      protected_paths: ["a/**", "b/**"],
      max_concurrency: 3,
    });
  });

  it("lists every problem and exits 1 when the import is rejected, writing nothing", async () => {
    await register();
    files["bad.yaml"] = `
tickets:
  - {key: a, repo: mobile, type: implementation, title: A, modules: [x], acceptance: [ok], blocked_by: [b]}
  - {key: b, repo: backend, type: implementation, title: B, modules: [y], acceptance: [ok], blocked_by: [a]}
external_blocked_by: [T-9]
`;
    const result = await plat("tickets", "import", "S-1", "bad.yaml");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/mobile/);
    expect(result.stderr).toMatch(/cycle/);
    expect(result.stderr).toMatch(/external_blocked_by/);
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM tickets")).rows[0].count,
      ),
    ).toBe(0);

    const asJson = await plat("--json", "tickets", "import", "S-1", "bad.yaml");
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout).errors).toHaveLength(3);
  });

  it("explains usage mistakes without calling the API", async () => {
    expect((await plat("tickets", "import", "T-1", "x.yaml")).stderr).toMatch(
      /not a spec id/,
    );
    expect(
      (await plat("tickets", "import", "S-1", "missing.yaml")).stderr,
    ).toMatch(/cannot read missing.yaml/);
    files["list.yaml"] = "- a\n- b\n";
    expect(
      (await plat("tickets", "import", "S-1", "list.yaml")).stderr,
    ).toMatch(/YAML mapping/);
    const notANumber = await plat(
      "repo",
      "add",
      "--project",
      "abc",
      "--role",
      "x",
      "--url",
      "u",
    );
    expect(notANumber.code).toBe(1);
    expect(notANumber.stderr).toMatch(/positive integer/);
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
          "!!!",
        )
      ).stderr,
    ).toMatch(/--slug/);
  });

  it("reports API refusals plainly", async () => {
    const unknownProject = await plat(
      "repo",
      "add",
      "--project",
      "9",
      "--role",
      "backend",
      "--url",
      "u",
    );
    expect(unknownProject).toMatchObject({
      code: 1,
      stderr: "error: no such project\n",
    });
    const badType = await plat(
      "spec",
      "create",
      "--project",
      "1",
      "--type",
      "epic",
      "--title",
      "x",
    );
    expect(badType.code).toBe(1);
  });

  it("says when the API is unreachable", async () => {
    let errors = "";
    const code = await run(["project", "create", "x"], {
      stdout: () => {},
      stderr: (text) => {
        errors += text;
      },
      env: { AFK_API_URL: "http://127.0.0.1:1" },
      readFile: async () => "",
    });
    expect(code).toBe(1);
    expect(errors).toMatch(/^error: cannot reach the API/);
  });
});

describe("the plat executable", () => {
  it("runs as a process against $AFK_API_URL", async () => {
    const bin = fileURLToPath(
      new URL("../../../cli/src/bin.ts", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [bin, "--json", "project", "create", "from-process"],
      { env: { ...process.env, AFK_API_URL: api.url } },
    );
    expect(JSON.parse(stdout)).toEqual({ id: 1, name: "from-process" });
  });
});
