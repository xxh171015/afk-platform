import { FAILURE_SOURCES } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { metricsView } from "../metrics/metrics.ts";
import { INT4_MAX } from "./schemas.ts";

const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const Attribution = z.object({
  source: z.enum(FAILURE_SOURCES),
  reason: z.string(),
  count: z.number().int(),
});

const metricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  request: {
    query: z.object({
      projectId: z.coerce.number().int().min(1).max(INT4_MAX).optional(),
    }),
  },
  responses: {
    200: reply(
      "The last 12 weeks of lead time, failure attribution, platform failure rate and success standards",
      z.object({
        since: z.string().nullable(),
        weeks: z.array(
          z.object({
            weekStart: z.string(),
            leadTime: z.object({
              ended: z.number().int(),
              medianMs: z.number().int().nullable(),
              agentMs: z.number().int(),
              gateMs: z.number().int(),
              queuedMs: z.number().int(),
              waitingMs: z.number().int(),
              specs: z.array(
                z.object({
                  id: z.number().int(),
                  displayId: z.string(),
                  title: z.string(),
                  totalMs: z.number().int(),
                }),
              ),
            }),
            attribution: z.object({
              recovered: z.array(Attribution),
              needsHuman: z.array(Attribution),
            }),
            failureRate: z.object({
              ended: z.number().int(),
              platform: z.number().nullable(),
              external: z.number().nullable(),
              jobPlatform: z.number().nullable(),
            }),
            success: z.object({
              mergedPulls: z.number().int(),
              mergeRate: z.number().nullable(),
              humanCommitsRate: z.number().nullable(),
              untouchedRate: z.number().nullable(),
            }),
          }),
        ),
      }),
    ),
  },
});

export function registerMetricsRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  app.openapi(metricsRoute, async (c) => {
    const projectId = c.req.valid("query").projectId;
    return c.json(
      await metricsView(context.pool, context.clock(), projectId),
      200,
    );
  });
}
