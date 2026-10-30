import { serve } from "@hono/node-server";
import type pg from "pg";
import { createApp } from "./app.ts";
import { assertMigrated } from "./db/migrate.ts";
import { defaultLogDir } from "./logs/log-store.ts";

// The API process. It only listens on this machine (no login: the platform is for one person, docs/specs/
// m1-platform.md), and it never migrates by itself: it refuses to start on a database that is behind.
export const HOST = "127.0.0.1";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(options: {
  pool: pg.Pool;
  port?: number; // 0 picks a free one
  logDir?: string;
}): Promise<RunningServer> {
  await assertMigrated(options.pool);
  const { rows } = await options.pool.query<{ id: string }>(
    "SELECT id FROM instance",
  );
  const logDir = options.logDir ?? defaultLogDir(rows[0]?.id ?? "");
  const app = createApp({ pool: options.pool, logDir });
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 3000, hostname: HOST },
      (info) => {
        resolve({
          url: `http://${HOST}:${info.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      },
    );
    // a port that is taken, or not allowed: say so instead of hanging
    server.once("error", reject);
  });
}
