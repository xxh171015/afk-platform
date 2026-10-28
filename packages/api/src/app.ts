import { OpenAPIHono } from "@hono/zod-openapi";
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

export function createApp(options: AppOptions): OpenAPIHono {
  const context: AppContext = {
    pool: options.pool,
    clock: options.clock ?? (() => new Date()),
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
    logs: new LogStore(options.logDir ?? defaultLogDir()),
  };
  const app = new OpenAPIHono();
  registerPlanningRoutes(app, context);
  registerWorkerRoutes(app, context);
  registerLogRoutes(app, context);
  registerTicketRoutes(app, context);
  return app;
}
