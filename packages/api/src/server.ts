import { serve } from "@hono/node-server";
import type pg from "pg";
import { createApp } from "./app.ts";
import { assertMigrated } from "./db/migrate.ts";
import { eventsHubOf } from "./events/hub.ts";
import { defaultLogDir, LogStore } from "./logs/log-store.ts";
import { retainLogs } from "./logs/retention.ts";
import { fanOutNotifications, macosNotifications } from "./notify/channel.ts";
import { dispatcherOf } from "./notify/dispatch.ts";
import { scheduleRunningSpecs } from "./scheduling/scheduler.ts";

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
  // ~/.afk/logs, so leftover run-* from before instance subdirectories can be removed. Omitted in tests.
  orphanRoot?: string;
  // How often every running spec gets a scheduling pass, for a trigger that was missed (0 turns it off).
  scheduleEveryMs?: number;
  // How often expired run logs are deleted (0 turns the timer off; a pass still runs at start).
  retentionEveryMs?: number;
}): Promise<RunningServer> {
  await assertMigrated(options.pool);
  const { rows } = await options.pool.query<{ id: string }>(
    "SELECT id FROM instance",
  );
  const logDir = options.logDir ?? defaultLogDir(rows[0]?.id ?? "");
  const app = createApp({
    pool: options.pool,
    logDir,
    notifications: fanOutNotifications([macosNotifications()]),
  });
  await eventsHubOf(app)?.whenReady();
  await dispatcherOf(app)?.start();
  const sweep = periodicScheduling(
    options.pool,
    options.scheduleEveryMs ?? 60_000,
  );
  const retention = periodicLogRetention({
    pool: options.pool,
    logDir,
    orphanRoot: options.orphanRoot,
    everyMs: options.retentionEveryMs ?? 24 * 60 * 60 * 1000,
  });
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 3000, hostname: HOST },
      (info) => {
        retention.start();
        resolve({
          url: `http://${HOST}:${info.port}`,
          close: async () => {
            await dispatcherOf(app)?.stop();
            await eventsHubOf(app)?.stop();
            await sweep.stop();
            await retention.stop();
            await new Promise<void>((done) => server.close(() => done()));
          },
        });
      },
    );
    server.once("error", () => {
      void sweep.stop();
      void retention.stop();
    });
    // a port that is taken, or not allowed: say so instead of hanging
    server.once("error", reject);
  });
}

// Every running spec gets a pass now and then, so a spec no event scheduled still starts. One pass at a time.
function periodicScheduling(pool: pg.Pool, everyMs: number) {
  let running: Promise<unknown> = Promise.resolve();
  let busy = false;
  const timer =
    everyMs > 0
      ? setInterval(() => {
          if (busy) return;
          busy = true;
          running = scheduleRunningSpecs(pool)
            .catch((error) => console.error("scheduling pass failed:", error))
            .finally(() => {
              busy = false;
            });
        }, everyMs)
      : undefined;
  timer?.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

function periodicLogRetention(options: {
  pool: pg.Pool;
  logDir: string;
  orphanRoot?: string;
  everyMs: number;
}) {
  let running: Promise<unknown> = Promise.resolve();
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pass = (cleanOrphans: boolean) => {
    if (busy) return;
    busy = true;
    running = retainLogs({
      pool: options.pool,
      logs: new LogStore(options.logDir),
      now: new Date(),
      logDir: options.logDir,
      orphanRoot: cleanOrphans ? options.orphanRoot : undefined,
    })
      .catch((error) => console.error("log retention failed:", error))
      .finally(() => {
        busy = false;
      });
  };
  return {
    start: () => {
      pass(true);
      if (options.everyMs > 0 && timer === undefined) {
        timer = setInterval(() => pass(false), options.everyMs);
        timer.unref();
      }
    },
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
