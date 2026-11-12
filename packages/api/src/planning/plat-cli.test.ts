import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Io, run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { LogStore } from "../logs/log-store.ts";
import { retainLogs } from "../logs/retention.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { type TestTicket, ticketFile } from "../test/ticket-files.ts";

// The plat commands against the real HTTP API and a real Postgres.

let db: TestDatabase;
let api: RunningApi;
let files: Record<string, string>;
let logDir: string;
let workDir: string | undefined;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  logDir = await mkdtemp(join(tmpdir(), "afk-logs-"));
  api = await listen(testApp({ pool: db.pool, logDir }));
  // a worker with the GitHub App has said so
  await db.pool.query(
    "INSERT INTO code_hosts (host, kind, worker_id) VALUES ('github.com', 'github', 'w1')",
  );
  files = {};
  workDir = undefined;
});
afterEach(async () => {
  await api.close();
  await db.drop();
  await rm(logDir, { recursive: true, force: true });
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
    env: { AFK_API_URL: api.url, AFK_ACCESS_WAIT_SECONDS: "0" },
    readFile: async (path) => {
      if (path === "docs/agents/issue-tracker.md")
        return await committedTrackerDoc(api.url);
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    readDirectory: async (path) => {
      const entries = Object.entries(files).filter(([name]) =>
        name.startsWith(`${path}/`),
      );
      if (entries.length === 0) throw new Error(`ENOENT ${path}`);
      return entries.map(([name, text]) => ({
        name: name.slice(path.length + 1),
        text,
      }));
    },
    cwd: workDir,
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

const TICKETS: TestTicket[] = [
  {
    key: "contract",
    repo: "backend",
    type: "contract",
    title: "Define the export endpoint",
    modules: ["openapi/**"],
    protected_paths_ok: ["openapi/openapi.yaml"],
    acceptance: ["openapi.yaml has GET /orders/export"],
    body: "details",
  },
  {
    key: "be",
    repo: "backend",
    type: "implementation",
    title: "Implement the export",
    modules: ["src/orders/**"],
    blocked_by: ["contract"],
    acceptance: ["returns CSV"],
  },
  {
    key: "be2",
    repo: "backend",
    type: "implementation",
    title: "Export filters",
    modules: ["src/orders/filters.ts"],
    blocked_by: ["contract"],
    acceptance: ["filters by customer"],
  },
  {
    key: "fe",
    repo: "frontend",
    type: "implementation",
    title: "Export button",
    modules: ["src/pages/orders/**"],
    contract: "contract",
    acceptance: ["button downloads the file"],
  },
];

// Writes the tickets as the files of a directory, the way plat reads them: numbered in the order given, which is
// the order the tickets are created in. Keys become "01-contract", "02-be", ...
function putTickets(directory: string, tickets: TestTicket[], specId = 1) {
  const keyOf = new Map(
    tickets.map((t, i) => [
      t.key,
      `${String(i + 1).padStart(2, "0")}-${t.key}`,
    ]),
  );
  const rename = (keys: string[] | undefined) =>
    keys?.map((k) => keyOf.get(k) ?? k);
  for (const ticket of tickets) {
    const file = ticketFile(specId, {
      ...ticket,
      key: keyOf.get(ticket.key) as string,
      blocked_by: rename(ticket.blocked_by),
      contract: rename([ticket.contract ?? []].flat()),
    });
    files[`${directory}/${file.name}`] = file.text;
  }
}

const SPEC_SECTIONS = [
  "Problem Statement",
  "Solution",
  "User Stories",
  "Implementation Decisions",
  "Testing Decisions",
  "Out of Scope",
  "Further Notes",
];
const SPEC_BODY = `${SPEC_SECTIONS.map((s) => `## ${s}\n\n${s === "Testing Decisions" ? "Seam: the HTTP API." : "text."}\n`).join("\n")}`;

async function register() {
  await plat("project", "create", "shop");
  await plat(
    "repo",
    "add",
    "--project",
    "1",
    "--name",
    "backend",
    "--url",
    "git@github.com:acme/backend.git",
  );
  await plat(
    "repo",
    "edit",
    "backend",
    "--project",
    "1",
    "--contract-path",
    "openapi.yaml",
  );
  await plat(
    "repo",
    "add",
    "--project",
    "1",
    "--name",
    "frontend",
    "--url",
    "git@github.com:acme/frontend.git",
  );
  files["spec.md"] = SPEC_BODY;
  const created = await plat(
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
  // These tests are not about planning docs (planning-docs-api.test.ts is): without a planning repo the tickets
  // start right after confirm, with no planning commit in between.
  await db.pool.query("UPDATE specs SET planning_repo_id = NULL");
  return created;
}

describe("plat", () => {
  it("registers and changes the host kind of a repo, and tracker-doc follows it", async () => {
    await db.pool.query(
      "INSERT INTO code_hosts (host, kind, worker_id) VALUES ('git.example.org', 'gitlab', 'w1')",
    );
    await plat("project", "create", "shop");
    const add = await plat(
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "backend",
      "--url",
      "https://git.example.org/acme/backend.git",
      "--host-kind",
      "gitlab",
    );
    expect(add.code).toBe(0);
    const doc = () =>
      plat("tracker-doc", "--project", "1", "--repo", "backend");
    expect((await doc()).stdout).toContain("## On GitLab");

    const edit = await plat(
      "repo",
      "edit",
      "backend",
      "--project",
      "1",
      "--host-kind",
      "github",
    );
    expect(edit.code).toBe(0);
    expect((await doc()).stdout).toContain("## On GitHub");

    const bad = await plat(
      "repo",
      "edit",
      "backend",
      "--project",
      "1",
      "--host-kind",
      "gitea",
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("github, gitlab");
    expect(
      (await plat("repo", "edit", "backend", "--project", "1")).stderr,
    ).toMatch(/nothing to change/);
  });

  async function createSpecFrom(text: string) {
    await plat("project", "create", "shop");
    await plat(
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "backend",
      "--url",
      "git@github.com:acme/backend.git",
    );
    files["spec.md"] = text;
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

  it("creates a spec with a missing or renamed section and warns which one", async () => {
    const body = SPEC_BODY.replace("## Solution", "## The Solution").replace(
      "## Out of Scope\n\ntext.\n",
      "",
    );
    const created = await createSpecFrom(body);
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("S-1\n");
    expect(created.stderr).toContain("warning: the spec has no ## Solution");
    expect(created.stderr).toContain(
      "warning: the spec has no ## Out of Scope",
    );
    expect(created.stderr).not.toContain("Problem Statement");
  });

  it("warns once when Testing Decisions does not name seams", async () => {
    const created = await createSpecFrom(
      SPEC_BODY.replace("Seam: the HTTP API.", "Write good tests."),
    );
    expect(created.code).toBe(0);
    expect(created.stderr).toContain("seams");
    expect(created.stderr.match(/warning/g)).toHaveLength(1);
  });

  it("does not warn when Testing Decisions names seams with 缝", async () => {
    const created = await createSpecFrom(
      SPEC_BODY.replace("Seam: the HTTP API.", "测试缝：HTTP API。"),
    );
    expect(created.code).toBe(0);
    expect(created.stderr).not.toContain("does not name the seams");
  });

  it("stores the body as written apart from line endings and the final newline", async () => {
    const created = await createSpecFrom(
      `${SPEC_BODY.trimEnd().replace(/\n/g, "\r\n")}\r\n\r\n`,
    );
    expect(created.stderr).toBe("");
    const stored = await db.pool.query("SELECT body FROM specs");
    expect(stored.rows[0].body).toBe(SPEC_BODY);
  });

  it("prints the spec body in spec show", async () => {
    await register();
    const shown = await plat("spec", "show", "S-1");
    expect(shown.stdout).toContain(
      "## Testing Decisions\n\nSeam: the HTTP API.",
    );
  });

  it("walks project create, repo add, spec create and tickets import", async () => {
    const spec = await register();
    expect(spec).toEqual({ code: 0, stdout: "S-1\n", stderr: "" });
    const stored = await db.pool.query("SELECT slug, body FROM specs");
    expect(stored.rows[0]).toEqual({ slug: "order-export", body: SPEC_BODY });

    putTickets("tickets", TICKETS);
    const imported = await plat("tickets", "import", "S-1", "tickets");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("imported 4 tickets into S-1");
    expect(imported.stdout).toContain("T-1  01-contract");
    expect(imported.stdout).toContain("warning: tickets 02-be and 03-be2");
    expect(
      Number((await db.pool.query("SELECT count(*) FROM edges")).rows[0].count),
    ).toBe(3);
  });

  it("names the registered repos and how to register one when a ticket's repo is not in the project", async () => {
    await register();
    putTickets("tickets", [
      { ...(TICKETS[3] as TestTicket), repo: "web", contract: undefined },
    ]);

    const imported = await plat("tickets", "import", "S-1", "tickets");

    expect(imported.code).not.toBe(0);
    expect(imported.stderr).toContain(
      "repo web does not belong to the project (its repos: backend, frontend); if it is another repo, set it up with the afk-setup skill (its checkout is a workspace folder), then import again",
    );
  });

  it("confirms the split and says what was queued", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
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

  it("prints uncovered User Stories as a yellow precheck and still confirms", async () => {
    await register();
    await db.pool.query("UPDATE specs SET body = $1", [
      SPEC_BODY.replace(
        "## User Stories\n\ntext.\n",
        [
          "## User Stories",
          "",
          "1. As a splitter, I want to name the User Stories a ticket is for.",
          "2. As an importer, I want unknown numbers rejected.",
          "3. As a reviewer, I want the assigned stories as counterparts.",
          "4. As an author of an infrastructure ticket, I want to omit stories.",
          "5. As a planner, I want uncovered User Stories listed before confirm.",
          "",
        ].join("\n"),
      ),
    ]);
    putTickets("tickets", [
      {
        key: "a",
        repo: "backend",
        type: "implementation",
        title: "A",
        modules: ["src/a/**"],
        acceptance: ["ok"],
        stories: [1, 3],
      },
      {
        key: "b",
        repo: "backend",
        type: "implementation",
        title: "B",
        modules: ["src/b/**"],
        acceptance: ["ok"],
        stories: [4],
      },
    ]);
    expect((await plat("tickets", "import", "S-1", "tickets")).code).toBe(0);
    const confirmed = await plat("spec", "confirm", "S-1");
    expect(confirmed.code).toBe(0);
    expect(confirmed.stderr).toContain(
      "yellow: 这几条 User Story 没有任何票负责：2, 5",
    );
    expect(confirmed.stdout).toContain("S-1 is running");
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
      "SELECT default_model, protected_paths, max_concurrency, budget_limit, limits FROM projects",
    );
    expect(row.rows[0]).toEqual({
      default_model: "composer-2",
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
    const moved = await plat(
      "project",
      "edit",
      "1",
      "--contract-path",
      "openapi.yaml",
    );
    expect(moved.code).toBe(1);
    expect(moved.stderr).toMatch(/plat repo edit <name>/);
    expect(
      (await plat("project", "create", "x", "--contract-path", "a.yaml"))
        .stderr,
    ).toMatch(/plat repo edit <name>/);
    expect(
      (await plat("project", "edit", "1", "--limit", "oops")).stderr,
    ).toMatch(/name=positive integer/);
    const none = await plat("project", "edit", "1");
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/nothing to change/);
  });

  it("writes and reads a project's Feishu chat id with --feishu-chat", async () => {
    await plat("project", "create", "shop");
    const edited = await plat(
      "project",
      "edit",
      "1",
      "--feishu-chat",
      "oc_shop",
    );
    expect(edited).toEqual({
      code: 0,
      stdout: "project 1 updated\n",
      stderr: "",
    });
    expect(
      (await db.pool.query("SELECT feishu_chat_id FROM projects WHERE id = 1"))
        .rows[0].feishu_chat_id,
    ).toBe("oc_shop");
    const shown = await plat("project", "show", "1");
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("oc_shop");
  });

  it("refuses project create with --default-agent claude-code and says only Cursor is supported", async () => {
    const refused = await plat(
      "project",
      "create",
      "shop",
      "--default-agent",
      "claude-code",
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("目前只支持 Cursor");
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM projects")).rows[0].count,
      ),
    ).toBe(0);
  });

  it("refuses project edit with --default-agent claude-code and leaves the stored value", async () => {
    await plat("project", "create", "shop");
    await db.pool.query(
      "UPDATE projects SET default_agent = 'codex' WHERE id = 1",
    );
    const refused = await plat(
      "project",
      "edit",
      "1",
      "--default-agent",
      "claude-code",
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("目前只支持 Cursor");
    expect(
      (await db.pool.query("SELECT default_agent FROM projects WHERE id = 1"))
        .rows[0].default_agent,
    ).toBe("codex");
  });

  it("accepts --default-agent cursor and omitting it on project create and edit", async () => {
    const omitted = await plat("project", "create", "plain");
    expect(omitted).toEqual({
      code: 0,
      stdout: "project 1 plain\n",
      stderr: "",
    });
    expect(
      (await db.pool.query("SELECT default_agent FROM projects WHERE id = 1"))
        .rows[0].default_agent,
    ).toBeNull();

    const created = await plat(
      "project",
      "create",
      "shop",
      "--default-agent",
      "cursor",
    );
    expect(created).toEqual({
      code: 0,
      stdout: "project 2 shop\n",
      stderr: "",
    });
    expect(
      (await db.pool.query("SELECT default_agent FROM projects WHERE id = 2"))
        .rows[0].default_agent,
    ).toBe("cursor");

    const edited = await plat(
      "project",
      "edit",
      "1",
      "--default-agent",
      "cursor",
    );
    expect(edited).toEqual({
      code: 0,
      stdout: "project 1 updated\n",
      stderr: "",
    });
    expect(
      (await db.pool.query("SELECT default_agent FROM projects WHERE id = 1"))
        .rows[0].default_agent,
    ).toBe("cursor");
  });

  it("leaves an existing unsupported default agent stored and marks it inactive in project show", async () => {
    await plat("project", "create", "shop", "--default-agent", "cursor");
    await db.pool.query(
      "UPDATE projects SET default_agent = 'claude-code' WHERE id = 1",
    );

    const shown = await plat("project", "show", "1");
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("claude-code");
    expect(shown.stdout).toContain("当前不生效");
    expect(
      (await db.pool.query("SELECT default_agent FROM projects WHERE id = 1"))
        .rows[0].default_agent,
    ).toBe("claude-code");

    await plat("project", "create", "plain");
    const unset = await plat("project", "show", "2");
    expect(unset.code).toBe(0);
    expect(unset.stdout).not.toContain("当前不生效");

    await plat("project", "edit", "2", "--default-agent", "cursor");
    const cursor = await plat("project", "show", "2");
    expect(cursor.code).toBe(0);
    expect(cursor.stdout).toContain("cursor");
    expect(cursor.stdout).not.toContain("当前不生效");
  });

  it("does not add a repo on a host no worker has credentials for, and says how to fix it", async () => {
    await plat("project", "create", "shop");
    const added = await plat(
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "api",
      "--url",
      "https://git.corp.example/team/api.git",
    );
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      "api 在 git.corp.example，平台没有这台主机的凭据",
    );
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM repos")).rows[0].n,
    ).toBe(0);
  });

  it("registers a repo by name (role still works) and sets, shows and clears its contract path", async () => {
    await plat("project", "create", "shop");
    const add = (...flags: string[]) =>
      plat("repo", "add", "--project", "1", "--url", "git@x:r", ...flags);
    expect(await add("--name", "backend")).toEqual({
      code: 0,
      stdout: "repo 1 backend\n",
      stderr: "",
    });
    expect((await add("--role", "worker")).stdout).toBe("repo 2 worker\n");
    expect((await add("--name", "backend")).code).toBe(1);
    expect((await add()).stderr).toMatch(/--name/);

    const edit = (...flags: string[]) =>
      plat("repo", "edit", "backend", "--project", "1", ...flags);
    expect(await edit("--contract-path", "openapi/openapi.yaml")).toEqual({
      code: 0,
      stdout: "repo 1 backend updated\n",
      stderr: "",
    });
    const paths = () =>
      db.pool.query("SELECT contract_path FROM repos ORDER BY id");
    expect((await paths()).rows).toEqual([
      { contract_path: "openapi/openapi.yaml" },
      { contract_path: null },
    ]);
    expect((await edit("--contract-path", "")).code).toBe(0);
    expect((await paths()).rows[0]).toEqual({ contract_path: null });
    expect((await edit()).stderr).toMatch(/nothing to change/);
    expect(
      (
        await plat(
          "repo",
          "edit",
          "nope",
          "--project",
          "1",
          "--contract-path",
          "a",
        )
      ).stderr,
    ).toBe("error: no such repo\n");
  });

  it("prints a run's log, all of it or from an offset, as text or JSON", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
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

  it("says when a run's log was purged under the retention policy", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
    await plat("spec", "confirm", "S-1");
    const worker = new FakeWorker(api.url, "w1", []);
    const job = (await worker.claim()).body.job;
    const runId = (
      await db.pool.query("SELECT id FROM runs WHERE job_id = $1", [job?.id])
    ).rows[0].id;
    await fetch(`${api.url}/worker/runs/${runId}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "w1",
        attempt: job?.attempt,
        chunk: "secret\n",
      }),
    });
    await db.pool.query("UPDATE specs SET state = 'cancelled'");
    await db.pool.query(
      `UPDATE events SET at = now() - interval '91 days'
        WHERE type = 'spec' AND to_state = 'cancelled'`,
    );
    await retainLogs({
      pool: db.pool,
      logs: new LogStore(logDir),
      now: new Date(),
    });
    const text = await plat("run", "logs", `R-${runId}`);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toMatch(
      /^日志已于 \d{4}-\d{2}-\d{2} 按保留策略清理\n$/,
    );
    const asJson = JSON.parse(
      (await plat("--json", "run", "logs", `R-${runId}`)).stdout,
    );
    expect(asJson.purgedAt).toBeTruthy();
    expect(asJson.text).toBe("");
  });

  // T-1 (the contract ticket) is claimed and its agent gives up: blocked, with a brief.
  async function blockedContract() {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
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
    expect(text.stdout).toContain("模型放弃");
    expect(text.stdout).toContain("看它卡住的地方，带一句话说明后继续");
    expect(text.stdout).toContain(
      'plat ticket retry T-1 --mode continue --note "…"',
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
    expect(json.items[0]).toEqual({ kind: "ticket", id: json.tickets[0].id });
  });

  it("prints the contract-change-needed ticket draft from the structured brief", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
    await plat("spec", "confirm", "S-1");
    const worker = new FakeWorker(api.url, "w1", []);
    const job = (await worker.claim()).body.job;
    await worker.complete(job?.id as number, job?.attempt as number, {
      stage: "implement",
      outcome: "contract-change-needed",
      run: {
        output: {
          status: "cannot-proceed",
          blockedReason: "contract-change-needed",
          detail: "Order needs a note field",
        },
      },
    });
    const json = JSON.parse((await plat("--json", "blocked")).stdout);
    const draft = json.tickets[0].structuredBrief.ticketDraft as string;
    expect(draft).toContain("type: contract");
    expect(draft).toContain("blocks: [T-1]");
    expect(draft).toContain("## What to build\n\nOrder needs a note field\n");
    const text = await plat("blocked");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("需要改契约");
    for (const line of draft.replace(/\n+$/, "").split("\n")) {
      if (line.length === 0) continue;
      expect(text.stdout).toContain(line);
    }
  });

  it("lists waiting items in the same order as items", async () => {
    await blockedContract();
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted' WHERE id = 1",
    );
    const json = JSON.parse((await plat("--json", "blocked")).stdout);
    const text = await plat("blocked");
    expect(json.items[0]).toEqual({ kind: "ticket", id: 1 });
    expect(json.items.map((item: { kind: string }) => item.kind)).toEqual([
      "ticket",
      "pausedSpec",
    ]);
    expect(text.stdout.split("\n")[0]).toContain("T-1");
  });

  it("says so when nothing waits", async () => {
    await register();
    expect((await plat("blocked")).stdout).toBe("nothing is waiting for you\n");
  });

  it("appends tickets to a confirmed spec with --append, and says so when the spec is still a draft", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
    putTickets("more", [
      {
        key: "extra",
        repo: "backend",
        type: "implementation",
        title: "Extra",
        modules: ["extra/**"],
        blocked_by: ["T-1"],
        acceptance: ["it works"],
      },
    ]);
    const early = await plat("tickets", "import", "S-1", "more", "--append");
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(/without --append/);

    await plat("spec", "confirm", "S-1");
    const appended = await plat("tickets", "import", "S-1", "more", "--append");
    expect(appended.code).toBe(0);
    expect(appended.stdout).toContain("appended 1 tickets to S-1");
    expect(appended.stdout).toMatch(/T-\d+ {2}01-extra/);
    expect((await plat("spec", "show", "S-1")).stdout).toContain("(appended)");
  });

  it("prints a ticket's file with --md, edits the ticket from such a file and shows an older version of it", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");

    const md = await plat("ticket", "view", "T-2", "--md");
    expect(md.code).toBe(0);
    expect(md.stdout).toMatch(/^---\nid: T-2\nversion: 1\ntitle: /);
    expect(md.stdout).toContain("blocked_by:\n  - T-1\n");
    expect(md.stdout).toContain("## Acceptance criteria");
    // byte for byte what the API hands the agent
    const viewed = JSON.parse(
      (await plat("--json", "ticket", "view", "T-2")).stdout,
    );
    expect(md.stdout).toBe(viewed.ticket.file);
    // the text view carries the body as well
    expect((await plat("ticket", "view", "T-2")).stdout).toContain(
      "- [ ] returns CSV",
    );

    files["edit.md"] = md.stdout
      .replace("Implement the export", "A better title")
      .replace("- [ ] returns CSV", "- [ ] it is faster");
    const edited = await plat("ticket", "edit", "T-2", "--file", "edit.md");
    expect(edited).toEqual({
      code: 0,
      stdout: "T-2 is now at version 2\n",
      stderr: "",
    });
    const again = await plat("ticket", "edit", "T-2", "--file", "edit.md");
    expect(again.stdout).toBe("T-2 is unchanged (version 2)\n");

    const now = (await plat("ticket", "view", "T-2")).stdout;
    expect(now).toContain("A better title");
    expect(now).toContain("- [ ] it is faster");
    expect(now).toContain("versions: 1, 2 (shown: 2)");
    const first = (await plat("ticket", "view", "T-2", "--version", "1"))
      .stdout;
    expect(first).not.toContain("A better title");
    expect(first).toContain("(shown: 1)");
    const firstMd = await plat(
      "ticket",
      "view",
      "T-2",
      "--md",
      "--version",
      "1",
    );
    expect(firstMd.stdout).toBe(md.stdout);

    files["bad.md"] = md.stdout.replace("repo: backend", "repo: frontend");
    const refused = await plat("ticket", "edit", "T-2", "--file", "bad.md");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/repo: .*cancel the ticket and append/);
  });

  it("shows the repo, refs and environment of tickets", async () => {
    await register();
    putTickets("tickets", [
      {
        key: "fe",
        repo: "frontend",
        type: "implementation",
        title: "Button",
        modules: ["src/**"],
        refs: ["backend"],
        acceptance: ["it works"],
      },
      {
        key: "e2e",
        repo: "frontend",
        type: "integration",
        title: "E2E",
        modules: ["e2e/**"],
        environment: ["backend"],
        blocked_by: ["fe"],
        acceptance: ["it works"],
      },
    ]);
    expect((await plat("tickets", "import", "S-1", "tickets")).code).toBe(0);
    const spec = (await plat("spec", "show", "S-1")).stdout;
    expect(spec).toContain("[frontend]  Button");
    expect(spec).toContain("refs: backend");
    expect(spec).toContain("environment: backend");
    expect((await plat("ticket", "view", "T-2")).stdout).toContain(
      "environment: backend",
    );
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
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
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

  it("takes a ticket over and hands it back, and retry points at handback", async () => {
    await register();
    putTickets("tickets", TICKETS);
    await plat("tickets", "import", "S-1", "tickets");
    await plat("spec", "confirm", "S-1");
    expect(await plat("ticket", "takeover", "T-1")).toEqual({
      code: 0,
      stdout: "T-1 is taken-over\n",
      stderr: "",
    });
    expect((await plat("blocked")).stdout).not.toMatch(/\bT-1\b/);
    const retry = await plat("ticket", "retry", "T-1", "--mode", "continue");
    expect(retry.code).toBe(1);
    expect(retry.stderr).toMatch(/plat ticket handback/);
    expect(await plat("ticket", "handback", "T-1")).toEqual({
      code: 0,
      stdout: "T-1 is queued\n",
      stderr: "",
    });
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

  it("retries with a note that the next Run reads", async () => {
    const worker = await blockedContract();
    const note = "use the helper in src/orders/csv.ts";
    expect(
      await plat(
        "ticket",
        "retry",
        "T-1",
        "--mode",
        "continue",
        "--note",
        note,
      ),
    ).toMatchObject({ code: 0 });
    const job = (await worker.claim()).body.job;
    const bundle = (await fetch(
      `${api.url}/worker/jobs/${job?.id}/bundle?workerId=w1&attempt=${job?.attempt}`,
    ).then((r) => r.json())) as {
      note: string | null;
      ticket: { file: string };
    };
    expect(bundle.note).toBe(note);
    expect(bundle.ticket.file).not.toContain(note);
  });

  it("retries a paused spec with more agent time, and can allow one through without", async () => {
    await blockedContract();
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'budget-exhausted'",
    );
    expect((await plat("blocked")).stdout).toContain(
      "S-1  paused  Order export: agent 时间用完",
    );
    expect((await plat("spec", "show", "S-1")).stdout).toContain(
      "paused: agent 时间用完",
    );
    const retried = await plat("spec", "retry", "S-1", "--extra-hours", "2");
    expect(retried).toEqual({
      code: 0,
      stdout: "S-1 is running\n",
      stderr: "",
    });
    const extra = await db.pool.query("SELECT budget_extra_seconds FROM specs");
    expect(extra.rows[0].budget_extra_seconds).toBe(7200);
    expect((await plat("spec", "resume", "S-1")).stderr).toMatch(
      /not allowed in running/,
    );
    await db.pool.query(
      "UPDATE specs SET state = 'paused', pause_reason = 'update-branch-conflict'",
    );
    const allowed = await plat("spec", "allow", "S-1");
    expect(allowed).toEqual({
      code: 0,
      stdout: "S-1 is running\n",
      stderr: "",
    });
    expect(
      (await db.pool.query("SELECT budget_extra_seconds FROM specs")).rows[0]
        .budget_extra_seconds,
    ).toBe(7200);
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
      /only a pending, blocked or taken-over ticket/,
    );
  });

  it("prints one JSON document with --json", async () => {
    await register();
    putTickets("tickets", TICKETS);
    const imported = await plat(
      "--json",
      "tickets",
      "import",
      "S-1",
      "tickets",
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
    putTickets("bad", [
      {
        key: "a",
        repo: "mobile",
        type: "implementation",
        title: "A",
        modules: ["x"],
        acceptance: ["ok"],
        blocked_by: ["b"],
      },
      {
        key: "b",
        repo: "backend",
        type: "implementation",
        title: "B",
        modules: ["y"],
        acceptance: ["ok"],
        blocked_by: ["a"],
      },
    ]);
    const result = await plat("tickets", "import", "S-1", "bad");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/mobile/);
    expect(result.stderr).toMatch(/cycle/);
    expect(
      Number(
        (await db.pool.query("SELECT count(*) FROM tickets")).rows[0].count,
      ),
    ).toBe(0);

    const asJson = await plat("--json", "tickets", "import", "S-1", "bad");
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout).errors).toHaveLength(2);
  });

  it("explains usage mistakes without calling the API", async () => {
    expect((await plat("tickets", "import", "T-1", "x")).stderr).toMatch(
      /not a spec id/,
    );
    expect((await plat("tickets", "import", "S-1", "missing")).stderr).toMatch(
      /cannot read the directory missing/,
    );
    expect(
      (await plat("tickets", "import", "S-1", "tickets.yaml")).stderr,
    ).toMatch(/tickets\.yaml is no longer accepted/);
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
      readDirectory: async () => [],
    });
    expect(code).toBe(1);
    expect(errors).toMatch(/^error: cannot reach the API/);
  });
});

describe("plat spec create --source", () => {
  it("writes the original spec on a bug and GET returns its display id", async () => {
    await register();
    const created = await plat(
      "spec",
      "create",
      "--project",
      "1",
      "--type",
      "bug",
      "--title",
      "Export crash",
      "--slug",
      "export-crash",
      "--source",
      "S-1",
    );
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("S-2\n");
    const view = (await (await fetch(`${api.url}/specs/2`)).json()) as {
      spec: { sourceSpec: { displayId: string } | null };
    };
    expect(view.spec.sourceSpec?.displayId).toBe("S-1");
  });

  it("creates a bug without --source and leaves the original spec empty", async () => {
    await plat("project", "create", "shop");
    const created = await plat(
      "spec",
      "create",
      "--project",
      "1",
      "--type",
      "bug",
      "--title",
      "Unknown crash",
      "--slug",
      "unknown-crash",
    );
    expect(created.code).toBe(0);
    const view = (await (await fetch(`${api.url}/specs/1`)).json()) as {
      spec: { sourceSpec: { displayId: string } | null };
    };
    expect(view.spec.sourceSpec).toBeNull();
  });
});

describe("plat bug", () => {
  const REPORT =
    "TypeError: Cannot read properties of undefined (reading 'id')\nat exportOrders (src/orders.ts:12)";

  it("creates a bug draft from the report and enqueues one locate-bug job", async () => {
    await plat("project", "create", "shop");
    await plat(
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "backend",
      "--url",
      "git@github.com:acme/backend.git",
    );
    files["report.txt"] = REPORT;
    const created = await plat("bug", "--project", "1", "--file", "report.txt");
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("S-1\n");
    const view = (await (await fetch(`${api.url}/specs/1`)).json()) as {
      spec: { type: string; state: string; body: string };
      tickets: unknown[];
    };
    expect(view.spec).toMatchObject({
      type: "bug",
      state: "draft",
      body: REPORT,
    });
    expect(view.tickets).toEqual([]);
    const jobs = await db.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT type, payload FROM jobs WHERE (payload->>'specId')::int = 1");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      type: "agent-run",
      payload: { stage: "locate-bug", specId: 1 },
    });
    expect(jobs.rows[0]?.payload).not.toHaveProperty("ticketId");
  });
});

describe("plat spec retry-locate", () => {
  it("enqueues locate again and does not import tickets or confirm", async () => {
    await plat("project", "create", "shop");
    await plat(
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "backend",
      "--url",
      "git@github.com:acme/backend.git",
    );
    files["report.txt"] = "no such file in this project";
    expect(
      (await plat("bug", "--project", "1", "--file", "report.txt")).code,
    ).toBe(0);
    const worker = new FakeWorker(api.url, "w1", []);
    const job = (await worker.claim()).body.job;
    await worker.complete(job?.id as number, job?.attempt as number, {
      stage: "locate-bug",
      outcome: "unlocated",
      locate: {
        repo: "",
        files: [],
        evidence: "none",
        reproduction: "",
        commits: [],
      },
      run: {
        output: {
          result: "unlocated",
          repo: "",
          files: [],
          evidence: "none",
          reproduction: "",
        },
      },
    });
    const retried = await plat("spec", "retry-locate", "S-1");
    expect(retried.code).toBe(0);
    const view = (await (await fetch(`${api.url}/specs/1`)).json()) as {
      spec: { state: string };
      tickets: unknown[];
    };
    expect(view.spec.state).toBe("draft");
    expect(view.tickets).toEqual([]);
    const jobs = await db.pool.query(
      `SELECT payload FROM jobs WHERE (payload->>'specId')::int = 1 AND payload->>'stage' = 'locate-bug'`,
    );
    expect(jobs.rows).toHaveLength(2);
    expect((await plat("spec", "retry-locate", "S-1")).code).toBe(1);
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
