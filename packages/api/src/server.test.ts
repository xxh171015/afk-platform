import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "./db/test-db.ts";
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
    db = await createTestDatabase();
    await migrate(db.pool);
    await db.pool.query(
      "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
    );
    await expect(startServer({ pool: db.pool, port: 0 })).rejects.toThrow(
      /1 migration\(s\) not applied/,
    );
  });

  it("serves on this machine only", async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    server = await startServer({ pool: db.pool, port: 0 });
    expect(HOST).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await fetch(`${server.url}/specs`);
    expect(await reply.json()).toEqual({ specs: [] });
  });

  it("lets the page on localhost call it from a browser, and nobody else", async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
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
