import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type pg from "pg";
import { EventsHub } from "./events/hub.ts";
import { registerCliRoutes } from "./http/cli-routes.ts";
import { registerEventRoutes, SSE_KEEPALIVE_MS } from "./http/event-routes.ts";
import { registerLogRoutes } from "./http/log-routes.ts";
import { registerPlanningRoutes } from "./http/planning-routes.ts";
import { registerTicketRoutes } from "./http/ticket-routes.ts";
import { registerWorkerRoutes } from "./http/worker-routes.ts";
import { LogStore } from "./logs/log-store.ts";
import {
  type NotificationChannel,
  silentNotifications,
} from "./notify/channel.ts";

export interface AppOptions {
  pool: pg.Pool;
  clock?: () => Date;
  leaseSeconds?: number;
  // Where run logs are kept; startServer fills in $AFK_LOG_DIR or ~/.afk/logs/<instance id>.
  logDir?: string;
  events?: EventsHub;
  notifications?: NotificationChannel;
  sseKeepaliveMs?: number;
}

export interface AppContext {
  pool: pg.Pool;
  clock: () => Date;
  leaseSeconds: number;
  logs: LogStore;
  events: EventsHub;
  notifications: NotificationChannel;
  sseKeepaliveMs: number;
}

export const LEASE_SECONDS = 120;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(options: AppOptions): OpenAPIHono {
  const context: AppContext = {
    pool: options.pool,
    clock: options.clock ?? (() => new Date()),
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
    logs: new LogStore(
      options.logDir ?? mkdtempSync(join(tmpdir(), "afk-logs-")),
    ),
    events: options.events ?? new EventsHub(),
    notifications: options.notifications ?? silentNotifications,
    sseKeepaliveMs: options.sseKeepaliveMs ?? SSE_KEEPALIVE_MS,
  };
  const app = new OpenAPIHono();
  // The API starts agents and has no login, so it only talks to this machine. CORS alone would only stop a foreign
  // page from reading answers: a plain cross-site POST would still be carried out. So a request that names a
  // foreign Origin (a browser on another site) or a foreign Host (DNS rebinding) is refused outright.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    const foreignOrigin = origin !== undefined && !LOCAL_ORIGIN.test(origin);
    const foreignHost = host !== undefined && !LOCAL_HOST.test(host);
    if (foreignOrigin || foreignHost) {
      return c.json(
        { error: "this API only answers requests from this machine" },
        403,
      );
    }
    await next();
  });
  // The page runs on another port of the same machine and may read the answers.
  app.use(
    "*",
    cors({ origin: (origin) => (LOCAL_ORIGIN.test(origin) ? origin : null) }),
  );
  registerPlanningRoutes(app, context);
  registerCliRoutes(app);
  registerWorkerRoutes(app, context);
  registerLogRoutes(app, context);
  registerTicketRoutes(app, context);
  registerEventRoutes(app, context);
  return app;
}
