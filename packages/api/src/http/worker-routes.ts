import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import {
  checkBeforePush,
  claimJob,
  completeJob,
  failJob,
  type HolderOutcome,
  heartbeat,
} from "../jobs/queue.ts";

const ClaimedJob = z.object({
  id: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  attempt: z.number().int(),
  lockKey: z.string().nullable(),
  leaseExpiresAt: z.string(),
});

const claimRoute = createRoute({
  method: "post",
  path: "/worker/jobs/claim",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            workerId: z.string().min(1),
            capabilities: z.array(z.string()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "A job leased to the worker, or null when nothing is claimable",
      content: {
        "application/json": {
          schema: z.object({ job: ClaimedJob.nullable() }),
        },
      },
    },
  },
});

const HolderBody = z.object({
  workerId: z.string().min(1),
  attempt: z.number().int(),
});
const ErrorReply = z.object({ error: z.string() });

function holderRoute<Extra extends z.ZodRawShape, Reply extends z.ZodType>(
  name: string,
  extra: Extra,
  reply: Reply,
) {
  return createRoute({
    method: "post",
    path: `/worker/jobs/{id}/${name}`,
    request: {
      params: z.object({ id: z.coerce.number().int() }),
      body: {
        content: { "application/json": { schema: HolderBody.extend(extra) } },
      },
    },
    responses: {
      200: {
        description: "Accepted",
        content: { "application/json": { schema: reply } },
      },
      404: {
        description: "No such job",
        content: { "application/json": { schema: ErrorReply } },
      },
      409: {
        description: "Not the lease holder at the current attempt (fencing)",
        content: { "application/json": { schema: ErrorReply } },
      },
    },
  });
}

const heartbeatRoute = holderRoute(
  "heartbeat",
  {},
  z.object({ leaseExpiresAt: z.string() }),
);
const prePushRoute = holderRoute(
  "pre-push",
  {},
  z.object({ ok: z.literal(true) }),
);
const completeRoute = holderRoute(
  "complete",
  { result: z.unknown() },
  z.object({ ok: z.literal(true) }),
);
const failRoute = holderRoute(
  "fail",
  { error: z.string() },
  z.object({ ok: z.literal(true) }),
);

function refusal(outcome: Exclude<HolderOutcome, { status: "ok" }>) {
  return outcome.status === "not-found"
    ? ({ body: { error: "no such job" }, status: 404 } as const)
    : ({
        body: { error: "stale attempt or lease not held" },
        status: 409,
      } as const);
}

export function registerWorkerRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  app.openapi(claimRoute, async (c) => {
    const { workerId, capabilities } = c.req.valid("json");
    const job = await claimJob(context.pool, {
      workerId,
      capabilities,
      now: context.clock(),
      leaseSeconds: context.leaseSeconds,
    });
    if (!job) return c.json({ job: null }, 200);
    return c.json(
      {
        job: {
          id: job.id,
          type: job.type,
          payload: job.payload as Record<string, unknown>,
          attempt: job.attempt,
          lockKey: job.lockKey,
          leaseExpiresAt: (job.leaseExpiresAt as Date).toISOString(),
        },
      },
      200,
    );
  });

  app.openapi(heartbeatRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt } = c.req.valid("json");
    const outcome = await heartbeat(context.pool, {
      jobId: id,
      workerId,
      attempt,
      now: context.clock(),
      leaseSeconds: context.leaseSeconds,
    });
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json(
      { leaseExpiresAt: outcome.leaseExpiresAt.toISOString() },
      200,
    );
  });

  app.openapi(prePushRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt } = c.req.valid("json");
    const outcome = await checkBeforePush(context.pool, {
      jobId: id,
      workerId,
      attempt,
      now: context.clock(),
    });
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(completeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, result } = c.req.valid("json");
    const outcome = await completeJob(
      context.pool,
      { jobId: id, workerId, attempt, now: context.clock() },
      result,
    );
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(failRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, error } = c.req.valid("json");
    const outcome = await failJob(
      context.pool,
      { jobId: id, workerId, attempt, now: context.clock() },
      error,
    );
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });
}
