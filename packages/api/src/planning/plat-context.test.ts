import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Io, run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi, testApp } from "../test/fake-worker.ts";
import { type TestTicket, ticketFile } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let files: Record<string, string>;
let workDir: string | undefined;
let checkouts: string[];

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(testApp({ pool: db.pool }));
  await db.pool.query(
    "INSERT INTO code_hosts (host, kind, worker_id) VALUES ('github.com', 'github', 'w1')",
  );
  files = {};
  workDir = undefined;
  checkouts = [];
});
afterEach(async () => {
  await api.close();
  await db.drop();
  for (const dir of checkouts) rmSync(dir, { recursive: true, force: true });
});

const REPO_URL = "https://github.com/acme/backend.git";
const SECRET_DECISION = "SECRET_DECISION_TEXT";
const SECRET_SCOPE = "SECRET_SCOPE_TEXT";
const FILE_BODY = "FILE_BODY_SHOULD_NOT_APPEAR";
const UNCOMMITTED = "UNCOMMITTED_LINE_SHOULD_BE_SKIPPED";
const ADR_PATH = "docs/adr/0001-pointers.md";

const SPEC_BODY = `## Problem Statement

p

## Solution

s

## User Stories

n/a

## Implementation Decisions

Use the checkout-pointer protocol. ${SECRET_DECISION}

## Testing Decisions

Seam: the HTTP API.

## Out of Scope

Do not copy file bodies. ${SECRET_SCOPE}

## Further Notes

See ${ADR_PATH}
`;

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

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function checkout(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-context-"));
  checkouts.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "a@b.c"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", origin]);
  return dir;
}

function commitFile(
  dir: string,
  path: string,
  content: string,
  message: string,
): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", path]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function registerBackend() {
  await plat("project", "create", "shop");
  await plat(
    "repo",
    "add",
    "--project",
    "1",
    "--name",
    "backend",
    "--url",
    REPO_URL,
  );
  files["spec.md"] = SPEC_BODY;
  await plat(
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
  const ticket: TestTicket = {
    key: "a",
    repo: "backend",
    type: "implementation",
    title: "Ticket a",
    modules: ["src/a/**"],
    acceptance: ["it works"],
  };
  const file = ticketFile(1, ticket);
  files[`tickets/${file.name}`] = file.text;
  expect((await plat("tickets", "import", "S-1", "tickets")).code).toBe(0);
}

describe("plat context --files", () => {
  it("returns pointers for committed lines, skips uncommitted ones, and exits 0 without copying file bodies", async () => {
    await registerBackend();
    const dir = checkout(REPO_URL);
    commitFile(
      dir,
      "src/orders.ts",
      `export const x = 1;\n// ${FILE_BODY}\n`,
      "add orders\n\nSpec: S-1\nTicket: T-1\n",
    );
    writeFileSync(
      join(dir, "src/orders.ts"),
      `export const x = 1;\n// ${FILE_BODY}\nexport const y = 2; // ${UNCOMMITTED}\n`,
    );
    workDir = dir;

    const result = await plat("context", "--files", "src/orders.ts");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("S-1");
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("Implementation Decisions");
    expect(result.stdout).toContain("Out of Scope");
    expect(result.stdout).toContain(ADR_PATH);
    expect(result.stdout).not.toContain(FILE_BODY);
    expect(result.stdout).not.toContain(UNCOMMITTED);
    expect(result.stdout).not.toContain(SECRET_DECISION);
    expect(result.stdout).not.toContain(SECRET_SCOPE);
  });

  it("requires --repo with a readable error when origin does not match, and succeeds when --repo names the platform repo", async () => {
    await registerBackend();
    const dir = checkout("https://github.com/other/other.git");
    commitFile(
      dir,
      "src/orders.ts",
      "export const x = 1;\n",
      "add orders\n\nSpec: S-1\nTicket: T-1\n",
    );
    workDir = dir;

    const missing = await plat("context", "--files", "src/orders.ts");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "this checkout's origin does not match a registered repo; pass --repo <name>",
    );

    const named = await plat(
      "context",
      "--files",
      "src/orders.ts",
      "--repo",
      "backend",
    );
    expect(named.code).toBe(0);
    expect(named.stdout).toContain("S-1");
    expect(named.stdout).toContain("T-1");
  });

  it("prints the same pointer document as JSON with --json", async () => {
    await registerBackend();
    const dir = checkout("git@github.com:acme/backend.git");
    commitFile(
      dir,
      "src/orders.ts",
      `export const x = 1;\n// ${FILE_BODY}\n`,
      "add orders\n\nSpec: S-1\nTicket: T-1\n",
    );
    workDir = dir;

    const result = await plat("--json", "context", "--files", "src/orders.ts");
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as {
      files: {
        path: string;
        specs: { displayId: string }[];
        tickets: { displayId: string }[];
        decisions: { heading: string }[];
        outOfScope: { heading: string }[];
        adrs: { path: string }[];
      }[];
    };
    expect(body.files).toEqual([
      expect.objectContaining({
        path: "src/orders.ts",
        specs: [expect.objectContaining({ displayId: "S-1" })],
        tickets: [expect.objectContaining({ displayId: "T-1" })],
        decisions: [
          expect.objectContaining({ heading: "Implementation Decisions" }),
        ],
        outOfScope: [expect.objectContaining({ heading: "Out of Scope" })],
        adrs: [{ path: ADR_PATH }],
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(FILE_BODY);
    expect(JSON.stringify(body)).not.toContain(SECRET_DECISION);
  });

  it("skips a file that is not in the repo yet and still exits 0", async () => {
    await registerBackend();
    const dir = checkout(REPO_URL);
    commitFile(dir, "README.md", "ok\n", "init");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    workDir = dir;

    const result = await plat("context", "--files", "new.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no committed lines");
  });
});
