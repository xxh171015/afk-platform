import { createPool } from "@afk/shared/db";
import { defaultLogsRoot } from "./logs/log-store.ts";
import { startServer } from "./server.ts";

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(
    `PORT must be a port number, got ${JSON.stringify(process.env.PORT)}`,
  );
  process.exit(1);
}
try {
  const server = await startServer({
    pool,
    port,
    orphanRoot: defaultLogsRoot(),
  });
  console.log(`afk api listening on ${server.url}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await pool.end();
  process.exitCode = 1;
}
