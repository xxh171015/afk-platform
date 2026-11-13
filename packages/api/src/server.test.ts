import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "./db/test-db.ts";
import { defaultLogDir } from "./logs/log-store.ts";
import { HOST, type RunningServer, startServer } from "./server.ts";

let db: TestDatabase | undefined;
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  await db?.drop();
  server = undefined;
  db = undefined;
});

describe("the API process", () => {
  it("refuses to start on a database that is behind, and says which migrations are missing", async () => {
    db = await createTestDatabase();
    await expect(startServer({ pool: db.pool, port: 0 })).rejects.toThrow(
      /migration\(s\) not applied.*pnpm db:migrate/,
    );
  });

  it("refuses to start on a database that was partly migrated too", async () => {
    db = await createMigratedTestDatabase();
    await db.pool.query(
      "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
    );
    await expect(startServer({ pool: db.pool, port: 0 })).rejects.toThrow(
      /1 migration\(s\) not applied/,
    );
  });

  it("serves on this machine only", async () => {
    db = await createMigratedTestDatabase();
    server = await startServer({ pool: db.pool, port: 0 });
    expect(HOST).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await fetch(`${server.url}/specs`);
    expect(await reply.json()).toEqual({ specs: [], nextCursor: null });
  });

  it("lets the page on localhost call it from a browser, and nobody else", async () => {
    db = await createMigratedTestDatabase();
    server = await startServer({ pool: db.pool, port: 0 });
    const ask = (origin: string) =>
      fetch(`${server?.url}/specs`, { headers: { origin } }).then((r) =>
        r.headers.get("access-control-allow-origin"),
      );
    expect(await ask("http://localhost:5173")).toBe("http://localhost:5173");
    expect(await ask("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
    expect(await ask("https://evil.example")).toBeNull();
    expect(await ask("http://localhost.evil.example")).toBeNull();
    const preflight = await fetch(`${server.url}/tickets/1/retry`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("requests that do not come from this machine", () => {
  async function running() {
    db = await createMigratedTestDatabase();
    server = await startServer({ pool: db.pool, port: 0 });
    const port = new URL(server.url).port;
    return {
      port,
      post: (headers: Record<string, string>) =>
        fetch(`${server?.url}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ name: "x" }),
        }),
    };
  }
  const projects = async () =>
    Number(
      (await db?.pool.query("SELECT count(*) FROM projects"))?.rows[0].count,
    );

  it("refuses a plain cross-site POST outright, so the action is not carried out", async () => {
    const { post } = await running();
    // a form on another site needs no preflight, and CORS would only hide the answer, not stop the action
    const reply = await post({
      origin: "https://evil.example",
      "content-type": "text/plain",
    });
    expect(reply.status).toBe(403);
    expect(await projects()).toBe(0);
  });

  it("refuses a request that names a foreign Host, as in DNS rebinding", async () => {
    const { port } = await running();
    // node's fetch will not let a header override Host, so speak HTTP directly
    const net = await import("node:net");
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          "GET /specs HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolve(data));
    });
    expect(answer).toContain("403");
    expect(answer).toContain("only answers requests from this machine");
  });

  it("still serves the page, a worker without an Origin, and local names", async () => {
    const { post } = await running();
    expect((await post({ origin: "http://localhost:5173" })).status).toBe(201);
    expect((await post({})).status).toBe(201); // a worker or the CLI sends no Origin
    expect(await projects()).toBe(2);
  });
});

describe("starting the process", () => {
  it("does not hang when the port is taken, and says so", async () => {
    db = await createMigratedTestDatabase();
    server = await startServer({ pool: db.pool, port: 0 });
    const port = Number(new URL(server.url).port);
    await expect(startServer({ pool: db.pool, port })).rejects.toThrow(
      /EADDRINUSE/,
    );
  });

  it("exits with an error naming pnpm db:migrate when the database is behind (the real entry point)", async () => {
    db = await createTestDatabase();
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${new URL(db.pool.options.connectionString as string).pathname.slice(1)}`;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const main = new URL("./main.ts", import.meta.url).pathname;
    const result = await promisify(execFile)(process.execPath, [main], {
      env: { ...process.env, DATABASE_URL: url.toString(), PORT: "0" },
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => ({
        code: error.code,
        stderr: error.stderr,
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /migration\(s\) not applied.*pnpm db:migrate/,
    );
  });

  it("refuses a PORT that is not a port number", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const main = new URL("./main.ts", import.meta.url).pathname;
    const result = await promisify(execFile)(process.execPath, [main], {
      env: { ...process.env, PORT: "abc" },
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => ({
        code: error.code,
        stderr: error.stderr,
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/PORT must be a port number/);
  });

  it("keeps run logs of each database in its own directory unless AFK_LOG_DIR says otherwise", () => {
    expect(defaultLogDir("a1b2c3", {})).toBe(
      join(homedir(), ".afk", "logs", "a1b2c3"),
    );
    expect(defaultLogDir("a1b2c3", { AFK_LOG_DIR: "/var/logs" })).toBe(
      "/var/logs",
    );
  });
});
