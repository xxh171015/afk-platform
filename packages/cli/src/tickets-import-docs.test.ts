import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "./index.ts";

let server: Server;
let url: string;
let imported: unknown[] = [];

beforeEach(async () => {
  imported = [];
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/specs/1") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          spec: {
            id: 1,
            projectId: 3,
            planning: { repo: "backend", state: null, sha: null, conflict: [] },
            prechecks: [],
          },
          tickets: [],
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/projects/3") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          id: 3,
          name: "shop",
          repos: [
            {
              name: "backend",
              url: "https://github.com/acme/backend.git",
              defaultBranch: "main",
              contractPath: null,
              hostKind: "github",
            },
          ],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url?.startsWith("/specs/1/tickets/import")
    ) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        imported.push(JSON.parse(body));
        res.statusCode = 200;
        res.end(JSON.stringify({ tickets: [], warnings: [] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "no" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise((done) => server.close(done)));

const TICKET = {
  name: "01-a.md",
  text: "---\nkey: a\nrepo: backend\ntype: implementation\ntitle: A\nmodules: [src/**]\nacceptance: [x]\n---\n",
};

function planningCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-import-docs-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
  spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/backend.git"],
    { cwd: dir },
  );
  writeFileSync(join(dir, "README.md"), "x\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

function importIo(cwd: string): Io {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    env: { HOME: "/nonexistent-home" },
    cwd,
    readFile: async (path) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
    readDirectory: async () => [TICKET],
  };
}

describe("plat tickets import planning-doc filenames", () => {
  it("sends unknown when this checkout is not the planning repo", async () => {
    const code = await run(
      ["--api-url", url, "tickets", "import", "S-1", "tickets"],
      importIo("/tmp"),
    );
    expect(code).toBe(0);
    expect(imported).toEqual([
      expect.objectContaining({
        planningDocsAtImport: { status: "unknown" },
      }),
    ]);
  });

  it("sends clean when the planning checkout has no planning-doc diff", async () => {
    const dir = planningCheckout();
    try {
      const code = await run(
        ["--api-url", url, "tickets", "import", "S-1", "tickets"],
        importIo(dir),
      );
      expect(code).toBe(0);
      expect(imported).toEqual([
        expect.objectContaining({
          planningDocsAtImport: { status: "clean" },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the changed planning-doc filenames, not their bodies", async () => {
    const dir = planningCheckout();
    writeFileSync(join(dir, "GLOSSARY.md"), "# terms\n");
    try {
      const code = await run(
        ["--api-url", url, "tickets", "import", "S-1", "tickets"],
        importIo(dir),
      );
      expect(code).toBe(0);
      expect(imported).toEqual([
        expect.objectContaining({
          planningDocsAtImport: {
            status: "changed",
            files: ["GLOSSARY.md"],
          },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
