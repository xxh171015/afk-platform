import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type pg from "pg";
import { registerLogRoutes } from "./http/log-routes.ts";
import { registerPlanningRoutes } from "./http/planning-routes.ts";
import { registerTicketRoutes } from "./http/ticket-routes.ts";
import { registerWorkerRoutes } from "./http/worker-routes.ts";
import { defaultLogDir, LogStore } from "./logs/log-store.ts";

export interface AppOptions {
  pool: pg.Pool;
  clock?: () => Date;
  leaseSeconds?: number;
  // Where run logs are kept: $AFK_LOG_DIR, else ~/.afk/logs.
  logDir?: string;
}

export interface AppContext {
  pool: pg.Pool;
  clock: () => Date;
  leaseSeconds: number;
  logs: LogStore;
}

export const LEASE_SECONDS = 120;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(options: AppOptions): OpenAPIHono {
  const context: AppContext = {
    pool: options.pool,
    clock: options.clock ?? (() => new Date()),
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
    logs: new LogStore(options.logDir ?? defaultLogDir()),
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
  registerWorkerRoutes(app, context);
  registerLogRoutes(app, context);
  registerTicketRoutes(app, context);
  return app;
}
