import { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import { registerWorkerRoutes } from "./http/worker-routes.ts";

export interface AppOptions {
  pool: pg.Pool;
  clock?: () => Date;
  leaseSeconds?: number;
}

export interface AppContext {
  pool: pg.Pool;
  clock: () => Date;
  leaseSeconds: number;
}

export const LEASE_SECONDS = 120;

export function createApp(options: AppOptions): OpenAPIHono {
  const context: AppContext = {
    pool: options.pool,
    clock: options.clock ?? (() => new Date()),
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
  };
  const app = new OpenAPIHono();
  registerWorkerRoutes(app, context);
  return app;
}
