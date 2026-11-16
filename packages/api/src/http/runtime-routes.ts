import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { agentsPause } from "../agents-pause.ts";
import type { AppContext } from "../app.ts";
import { refreshDiskStatus } from "../disk.ts";
import { runtimeView } from "../runtime/runtime.ts";

const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const RuntimeJob = z.object({
  id: z.number().int(),
  type: z.string(),
  state: z.enum(["running", "queued"]),
  attempt: z.number().int(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  lockKey: z.string().nullable(),
  notBefore: z.string().nullable(),
  label: z.string(),
  stage: z.string().nullable(),
  specId: z.number().int().nullable(),
  specDisplayId: z.string().nullable(),
  ticketId: z.number().int().nullable(),
  ticketDisplayId: z.string().nullable(),
  runId: z.number().int().nullable(),
});

const RuntimeWorker = z.object({
  id: z.string(),
  reportedAt: z.string(),
  freeBytes: z.number().nullable(),
  cleaned: z.object({
    sandboxLogs: z.number().int(),
    salvage: z.number().int(),
    snapshots: z.number().int(),
  }),
  heldJobId: z.number().int().nullable(),
});

const RuntimeStatus = z.object({
  agentsPaused: z
    .object({
      since: z.string(),
      reason: z.string(),
      nextProbeAt: z.string().nullable(),
    })
    .nullable(),
  logDirBytes: z.number(),
  apiFreeBytes: z.number(),
  diskLevel: z.enum(["ok", "warn", "stop"]),
  warnGib: z.number(),
  stopGib: z.number(),
  lastCleanup: z.object({
    at: z.string().nullable(),
    runs: z.number().int(),
    orphans: z.number().int(),
  }),
  workers: z.array(
    z.object({
      id: z.string(),
      reportedAt: z.string(),
      freeBytes: z.number().nullable(),
      cleaned: z.object({
        sandboxLogs: z.number().int(),
        salvage: z.number().int(),
        snapshots: z.number().int(),
      }),
    }),
  ),
  feishu: z.object({
    open: z.boolean(),
    closedReason: z.enum(["missing", "permissions", "invalid"]).nullable(),
  }),
});

const runtimeRoute = createRoute({
  method: "get",
  path: "/runtime",
  responses: {
    200: reply(
      "Live jobs, workers and platform instance status",
      z.object({
        instance: z.object({ id: z.string() }),
        summary: z.object({
          running: z.number().int(),
          queued: z.number().int(),
        }),
        jobs: z.object({
          running: z.array(RuntimeJob),
          queued: z.array(RuntimeJob),
        }),
        workers: z.array(RuntimeWorker),
        status: RuntimeStatus,
      }),
    ),
  },
});

export function registerRuntimeRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  app.openapi(runtimeRoute, async (c) => {
    const pool = context.pool;
    const sample = await context.statDisk(context.logDir);
    const disk = await refreshDiskStatus(pool, sample);
    const feishu = context.feishu.state;
    return c.json(
      {
        ...(await runtimeView(pool)),
        status: {
          ...disk,
          agentsPaused: await agentsPause(pool),
          feishu: feishu.open
            ? { open: true, closedReason: null }
            : { open: false, closedReason: feishu.closedReason },
        },
      },
      200,
    );
  });
}