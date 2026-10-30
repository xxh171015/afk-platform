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
  await plat(
    "project",
    "create",
    "shop",
    "--contract-path",
    "backend:openapi.yaml",
  );
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
    const id = (await db.pool.query("SELECT id FROM instance")).rows[0].id;
    expect(confirmed.stdout).toContain(`spec/${id}/order-export`);
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

  it("edits an existing project: only the given settings change, and mistakes are reported", async () => {
    await plat("project", "create", "shop", "--protected-path", ".github/**");
    const edited = await plat(
      "project",
      "edit",
      "1",
      "--contract-path",
      "backend:openapi.yaml",
      "--max-concurrency",
      "3",
      "--budget-limit",
      "50",
      "--default-model",
      "composer-2",
      "--limit",
      "repoConcurrency=4",
    );
    expect(edited).toEqual({
      code: 0,
      stdout: "project 1 updated\n",
      stderr: "",
    });
    const row = await db.pool.query(
      "SELECT default_model, contract_path, protected_paths, max_concurrency, budget_limit, limits FROM projects",
    );
    expect(row.rows[0]).toEqual({
      default_model: "composer-2",
      contract_path: "backend:openapi.yaml",
      protected_paths: [".github/**"],
      max_concurrency: 3,
      budget_limit: 50,
      limits: { repoConcurrency: 4 },
    });
    await plat("project", "edit", "1", "--protected-path", "infra/**");
    expect(
      (await db.pool.query("SELECT protected_paths FROM projects")).rows[0],
    ).toEqual({ protected_paths: ["infra/**"] });

    expect(
      (await plat("project", "edit", "9", "--budget-limit", "5")).stderr,
    ).toBe("error: no such project\n");
    expect(
      (await plat("project", "edit", "1", "--contract-path", "openapi.yaml"))
        .code,
    ).toBe(1);
    expect(
      (await plat("project", "edit", "1", "--limit", "oops")).stderr,
    ).toMatch(/name=positive integer/);
    const none = await plat("project", "edit", "1");
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/nothing to change/);
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

  // T-1 (the contract ticket) is claimed and its agent gives up: blocked, with a brief.
  async function blockedContract() {
    await register();
    files["tickets.yaml"] = TICKETS_YAML;
    await plat("tickets", "import", "S-1", "tickets.yaml");
    await plat("spec", "confirm", "S-1");
    const worker = new FakeWorker(api.url, "w1", []);
    const job = (await worker.claim()).body.job;
    await worker.complete(job?.id as number, job?.attempt as number, {
      stage: "implement",
      outcome: "agent-gave-up",
      run: {
        output: {
          status: "cannot-proceed",
          blockedReason: "agent-gave-up",
          detail: "needs a decision",
        },
      },
    });
    return worker;
  }

  it("lists what waits for a person, with the brief and where to read the log", async () => {
    await blockedContract();
    const text = await plat("blocked");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      "T-1  S-1  blocked (agent-gave-up)  Define the export endpoint",
    );
    expect(text.stdout).toContain(
      "implement ended agent-gave-up in R-1: needs a decision",
    );
    expect(text.stdout).toContain("plat run logs R-1");
    const json = JSON.parse((await plat("--json", "blocked")).stdout);
    expect(json.tickets[0]).toMatchObject({
      displayId: "T-1",
      blockedReason: "agent-gave-up",
      brief: { stage: "implement" },
    });
    expect(json.specs).toEqual([]);
  });

  it("says so when nothing waits", async () => {
    await register();
    expect((await plat("blocked")).stdout).toBe("nothing is waiting for you\n");
  });

  it("shows a ticket and a spec", async () => {
    await blockedContract();
    const ticket = await plat("ticket", "view", "T-1");
    expect(ticket.stdout).toContain(
      "T-1  blocked (agent-gave-up)  Define the export endpoint",
    );
    expect(ticket.stdout).toContain("openapi.yaml has GET /orders/export");
    expect(ticket.stdout).toContain("R-1  implement #1  agent-gave-up");
    expect(ticket.stdout).toContain("blocks:");
    expect(
      JSON.parse((await plat("--json", "ticket", "view", "T-1")).stdout).ticket
        .displayId,
    ).toBe("T-1");

    const spec = await plat("spec", "show", "S-1");
    expect(spec.stdout).toContain("S-1  running  Order export");
    expect(spec.stdout).toContain("T-1  blocked (agent-gave-up)");
    expect(spec.stdout).toContain("T-1 -> T-2 (blocks)");
    expect(spec.stdout).toContain("warning");
    expect((await plat("ticket", "view", "S-1")).stderr).toMatch(
      /not a ticket id/,
    );
    expect((await plat("ticket", "view", "T-99")).stderr).toMatch(
      /no such ticket/,
    );
    expect((await plat("spec", "show", "S-99")).stderr).toMatch(/no such spec/);
  });

  it("approves protected paths for a blocked ticket, and says to retry it", async () => {
    await blockedContract();
    const allowed = await plat(
      "ticket",
      "allow-path",
      "T-1",
      ".github/CODEOWNERS",
      "tsconfig.json",
    );
    expect(allowed).toEqual({
      code: 0,
      stdout:
        "approved for T-1: openapi/openapi.yaml, .github/CODEOWNERS, tsconfig.json; retry it with: plat ticket retry T-1 --mode continue|restart\n",
      stderr: "",
    });
    const viewed = await plat("ticket", "view", "T-1");
    expect(viewed.stdout).toContain(
      "approved protected paths: openapi/openapi.yaml, .github/CODEOWNERS, tsconfig.json",
    );
    await plat("ticket", "retry", "T-1", "--mode", "restart"); // now it is queued, not blocked
    expect((await plat("ticket", "allow-path", "T-1", "x")).stderr).toMatch(
      /only a blocked ticket/,
    );
    expect((await plat("ticket", "allow-path", "T-99", "x")).stderr).toMatch(
      /no such ticket/,
    );
  });

  it("cancels a spec: its tickets go with it, spec show says cancelled, and a second cancel is refused", async () => {
    await register();
    files["tickets.yaml"] = TICKETS_YAML;
    await plat("tickets", "import", "S-1", "tickets.yaml");
    await plat("spec", "confirm", "S-1");
    const cancelled = await plat("spec", "cancel", "S-1");
    expect(cancelled).toEqual({
      code: 0,
      stdout:
        "S-1 is cancelled; cancelled T-1, T-2, T-3, T-4\n" +
        "a worker that has the code host will close its open pull requests and delete its spec/* and agent/* branches\n",
      stderr: "",
    });
    const shown = await plat("spec", "show", "S-1");
    expect(shown.stdout).toMatch(/^S-1 {2}cancelled /);
    expect(shown.stdout).toMatch(/T-1 {2}cancelled/);
    expect((await plat("spec", "cancel", "S-1")).stderr).toMatch(
      /not allowed in cancelled/,
    );
    expect((await plat("spec", "cancel", "S-99")).stderr).toMatch(
      /no such spec/,
    );
    expect((await plat("spec", "cancel", "T-1")).stderr).toMatch(
      /not a spec id/,
    );
  });

  it("retries, cancels and approves, and refuses what does not apply", async () => {
    await blockedContract();
    expect((await plat("ticket", "approve-protected", "T-1")).stderr).toMatch(
      /protected-path-changed/,
    );
    expect(
      (await plat("ticket", "retry", "T-1", "--mode", "sometimes")).stderr,
    ).toMatch(/--mode must be/);
    expect((await plat("ticket", "retry", "T-1")).code).toBe(1); // --mode is required

    const retried = await plat("ticket", "retry", "T-1", "--mode", "restart");
    expect(retried).toEqual({ code: 0, stdout: "T-1 is queued\n", stderr: "" });
    expect(
      (await plat("ticket", "retry", "T-1", "--mode", "continue")).stderr,
    ).toMatch(/not allowed in queued/);
  });

  it("resumes a paused spec with more agent time", async () => {
    await blockedContract();
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'the agent time limit of the spec was reached'",
    );
    expect((await plat("blocked")).stdout).toContain(
      "S-1  paused  Order export: the agent time limit",
    );
    expect((await plat("spec", "show", "S-1")).stdout).toContain(
      "paused: the agent time limit",
    );
    const resumed = await plat("spec", "resume", "S-1", "--extra-hours", "2");
    expect(resumed).toEqual({
      code: 0,
      stdout: "S-1 is running\n",
      stderr: "",
    });
    const extra = await db.pool.query("SELECT budget_extra_seconds FROM specs");
    expect(extra.rows[0].budget_extra_seconds).toBe(7200);
    expect((await plat("spec", "resume", "S-1")).stderr).toMatch(
      /not allowed in running/,
    );
  });

  it("shows a blocked overall review and runs its blocked step again", async () => {
    await blockedContract();
    await db.pool.query(
      "UPDATE tickets SET state = 'done', blocked_reason = NULL",
    );
    await db.pool.query("UPDATE specs SET state = 'finalizing'");
    await db.pool.query(
      "INSERT INTO finalizations (spec_id, repo_id, step, state, blocked_reason) VALUES (1, 1, 'final-merge', 'blocked', 'merge-conflict')",
    );
    await db.pool.query(
      "INSERT INTO runs (spec_id, repo_id, stage, result, output) VALUES (1, 1, 'final-merge', 'conflict', '{\"failureLog\": \"# merge conflict\"}')",
    );
    const blocked = await plat("blocked");
    expect(blocked.stdout).toContain(
      "S-1  overall review of backend: final-merge blocked (merge-conflict)",
    );
    expect(blocked.stdout).toContain("then: plat spec retry-final S-1");
    expect((await plat("spec", "show", "S-1")).stdout).toContain(
      "overall review:",
    );
    const retried = await plat("spec", "retry-final", "S-1");
    expect(retried).toEqual({
      code: 0,
      stdout: "S-1: running again: final-merge\n",
      stderr: "",
    });
    expect((await plat("spec", "retry-final", "S-1")).stderr).toMatch(
      /no blocked finalization/,
    );
  });

  it("cancels with and without cascade", async () => {
    await blockedContract();
    const plain = await plat("ticket", "cancel", "T-1");
    expect(plain.stdout).toContain("cancelled: T-1");
    expect(plain.stdout).toContain(
      "blocked (upstream-cancelled): T-2, T-3, T-4",
    );
    // the ones it blocked can be cancelled in turn
    const next = JSON.parse(
      (await plat("--json", "ticket", "cancel", "T-2", "--cascade")).stdout,
    );
    expect(next).toEqual({ cancelled: ["T-2"], blocked: [], skipped: [] });
    expect((await plat("ticket", "cancel", "T-2")).stderr).toMatch(
      /only a pending or blocked ticket/,
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
