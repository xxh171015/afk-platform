import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, HOST_HEADER } from "@afk/shared";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type pg from "pg";
import { type DiskSample, sampleDisk, volumeFreeBytes } from "./disk.ts";
import { bindEventsHub, EventsHub } from "./events/hub.ts";
import { withOrigin } from "./events/origin.ts";
import { registerCliRoutes } from "./http/cli-routes.ts";
import { registerEventRoutes, SSE_KEEPALIVE_MS } from "./http/event-routes.ts";
import { registerLogRoutes } from "./http/log-routes.ts";
import { registerMetricsRoutes } from "./http/metrics-routes.ts";
import { registerPlanningRoutes } from "./http/planning-routes.ts";
import { refuseOutdatedPlat } from "./http/plat-freshness.ts";
import { registerTicketRoutes } from "./http/ticket-routes.ts";
import { registerWorkerRoutes } from "./http/worker-routes.ts";
import { LogStore } from "./logs/log-store.ts";
import {
  fanOutNotifications,
  macosNotifications,
  type NotificationChannel,
  type RunCommand,
  silentNotifications,
} from "./notify/channel.ts";
import { bindDispatcher, NotificationDispatcher } from "./notify/dispatch.ts";
import {
  createFeishuChannel,
  type FeishuHandle,
  type FeishuHttp,
  feishuSecretsPath,
} from "./notify/feishu.ts";

export interface AppOptions {
  pool: pg.Pool;
  clock?: () => Date;
  leaseSeconds?: number;
  // Where run logs are kept; startServer fills in $AFK_LOG_DIR or ~/.afk/logs/<instance id>.
  logDir?: string;
  // Tests inject remaining space so GET /workbench does not depend on the machine's disk.
  statDisk?: (path: string) => Promise<DiskSample>;
  events?: EventsHub;
  notifications?: NotificationChannel;
  // When true and notifications is omitted, assemble macOS plus an open Feishu channel.
  liveNotifications?: boolean;
  macosRun?: RunCommand;
  feishu?: {
    secretsPath?: string;
    http?: FeishuHttp;
    defaultChatId?: string;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
  };
  sseKeepaliveMs?: number;
  // Tests inject this so the 30s notice window can fire when FakeClock advances.
  schedule?: (ms: number, fn: () => unknown) => () => void;
}

export interface AppContext {
  pool: pg.Pool;
  clock: () => Date;
  leaseSeconds: number;
  logs: LogStore;
  logDir: string;
  statDisk: (path: string) => Promise<DiskSample>;
  // Claim uses this instead of statDisk so a live API does not walk the log dir every poll.
  freeBytes: (path: string) => Promise<number>;
  events: EventsHub;
  notifications: NotificationChannel;
  feishu: FeishuHandle;
  sseKeepaliveMs: number;
  schedule: (ms: number, fn: () => unknown) => () => void;
}

export const LEASE_SECONDS = 120;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(options: AppOptions): OpenAPIHono {
  const logDir = options.logDir ?? mkdtempSync(join(tmpdir(), "afk-logs-"));
  const injectedStat = options.statDisk;
  const feishu = createFeishuChannel({
    secretsPath: options.feishu?.secretsPath ?? feishuSecretsPath(),
    http: options.feishu?.http,
    clock: options.feishu?.clock,
    sleep: options.feishu?.sleep,
    log: options.feishu?.log,
    defaultChatId:
      options.feishu?.defaultChatId ?? process.env.AFK_FEISHU_DEFAULT_CHAT,
    resolveChatId: async (projectId) => {
      if (typeof options.pool?.query !== "function" || projectId == null) {
        return undefined;
      }
      try {
        const { rows } = await options.pool.query<{
          feishu_chat_id: string | null;
        }>("SELECT feishu_chat_id FROM projects WHERE id = $1", [projectId]);
        return rows[0]?.feishu_chat_id ?? undefined;
      } catch {
        return undefined;
      }
    },
  });
  const live = fanOutNotifications([
    macosNotifications(options.macosRun),
    ...(feishu.state.open ? [feishu.channel] : []),
  ]);
  const context: AppContext = {
    pool: options.pool,
    clock: options.clock ?? (() => new Date()),
    leaseSeconds: options.leaseSeconds ?? LEASE_SECONDS,
    logs: new LogStore(logDir),
    logDir,
    statDisk: injectedStat ?? sampleDisk,
    freeBytes: injectedStat
      ? async (path) => (await injectedStat(path)).freeBytes
      : volumeFreeBytes,
    events: options.events ?? new EventsHub(),
    notifications:
      options.notifications ??
      (options.liveNotifications ? live : silentNotifications),
    feishu,
    sseKeepaliveMs: options.sseKeepaliveMs ?? SSE_KEEPALIVE_MS,
    schedule:
      options.schedule ??
      ((ms, fn) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      }),
  };
  const app = new OpenAPIHono();
  bindEventsHub(app, context.events);
  bindDispatcher(
    app,
    new NotificationDispatcher({
      pool: context.pool,
      hub: context.events,
      notifications: context.notifications,
      schedule: context.schedule,
    }),
  );
  if (
    options.events === undefined &&
    typeof options.pool?.connect === "function"
  ) {
    void context.events.listen(options.pool);
  }
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
  // Who a request's changes are recorded as (events/origin.ts): a worker, the CLI (it says so), or the page.
  app.use("*", (c, next) => {
    if (c.req.path.startsWith("/worker/"))
      return withOrigin({ source: "worker" }, next);
    const cli = c.req.header(CLIENT_HEADER) === "cli";
    return withOrigin(
      {
        source: cli ? "cli" : "page",
        host: (cli && c.req.header(HOST_HEADER)) || hostname(),
      },
      next,
    );
  });
  // The page runs on another port of the same machine and may read the answers.
  app.use(
    "*",
    cors({ origin: (origin) => (LOCAL_ORIGIN.test(origin) ? origin : null) }),
  );
  // An older plat does not publish (http/plat-freshness.ts).
  app.use("*", refuseOutdatedPlat);
  registerPlanningRoutes(app, context);
  registerCliRoutes(app);
  registerWorkerRoutes(app, context);
  registerLogRoutes(app, context);
  registerTicketRoutes(app, context);
  registerMetricsRoutes(app, context);
  registerEventRoutes(app, context);
  return app;
}
