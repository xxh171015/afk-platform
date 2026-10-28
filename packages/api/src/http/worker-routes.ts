import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { markFinalClaimed, recordFinalResult } from "../finalize/finalize.ts";
import {
  checkBeforePush,
  checkHolder,
  claimJob,
  completeJob,
  failJob,
  type HolderOutcome,
  heartbeat,
} from "../jobs/queue.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import { buildBundle } from "../stages/bundle.ts";
import { recordJobFailure } from "../stages/failures.ts";
import { markClaimed, recordStageResult } from "../stages/results.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

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
            workerId: z.string().min(1).max(200),
            capabilities: z.array(z.string().max(200)).max(100),
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
  workerId: z.string().min(1).max(200),
  attempt: z.number().int().min(1).max(INT4_MAX),
});

function holderRoute<Extra extends z.ZodRawShape, Reply extends z.ZodType>(
  name: string,
  extra: Extra,
  reply: Reply,
) {
  return createRoute({
    method: "post",
    path: `/worker/jobs/{id}/${name}`,
    request: {
      params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
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
const Bundle = z.object({
  job: z.object({
    id: z.number().int(),
    stage: z.string(),
    attempt: z.number().int(),
  }),
  run: z.object({ id: z.number().int(), displayId: z.string() }).nullable(),
  ticket: z
    .object({
      id: z.number().int(),
      displayId: z.string(),
      type: z.string(),
      title: z.string(),
      body: z.string(),
      acceptanceCriteria: z.array(z.string()),
      modules: z.array(z.string()),
      state: z.string(),
      contentVersion: z.number().int(),
      fixCounts: z.record(z.string(), z.number().int()),
      reviewed: z.boolean(),
      restart: z.boolean(),
    })
    .nullable(),
  specTickets: z.array(
    z.object({
      displayId: z.string(),
      title: z.string(),
      acceptanceCriteria: z.array(z.string()),
    }),
  ),
  spec: z.object({
    id: z.number().int(),
    displayId: z.string(),
    slug: z.string(),
    title: z.string(),
    body: z.string(),
    type: z.string(),
  }),
  repo: z.object({
    id: z.number().int(),
    role: z.string(),
    url: z.string(),
    defaultBranch: z.string(),
  }),
  integrationBranch: z.string().nullable(),
  protectedPaths: z.array(z.string()),
  allowedProtectedPaths: z.array(z.string()),
  contract: z
    .object({ sha: z.string(), path: z.string(), repoId: z.number().int() })
    .nullable(),
  failureLog: z.string().nullable(),
  review: z.unknown(),
  gateBaseline: z
    .object({ tests: z.number().int(), skipped: z.number().int() })
    .nullable(),
});

const bundleRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/bundle",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({
      workerId: z.string().min(1).max(200),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: {
      description: "What the worker renders into /context for this job",
      content: { "application/json": { schema: Bundle } },
    },
    404: {
      description: "No such job, or the job has no ticket",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

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
    await markClaimed(context.pool, job);
    await markFinalClaimed(context.pool, job);
    return c.json(
      {
        job: {
          id: job.id,
          type: job.type,
          payload: job.payload,
          attempt: job.attempt,
          lockKey: job.lockKey,
          leaseExpiresAt: job.leaseExpiresAt.toISOString(),
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
      leaseSeconds: context.leaseSeconds,
    });
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json(
      {
        ok: true as const,
        leaseExpiresAt: outcome.leaseExpiresAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(completeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, result } = c.req.valid("json");
    // The job finishing and the ticket moving on happen together or not at all.
    const outcome = await inTransaction(context.pool, async (client) => {
      const finished = await completeJob(
        client,
        { jobId: id, workerId, attempt, now: context.clock() },
        result,
      );
      if (finished.status === "ok") {
        const job = await client.query(
          "SELECT id, payload FROM jobs WHERE id = $1",
          [id],
        );
        const recorded = await recordStageResult(client, job.rows[0], result);
        // not a ticket stage: it may be a step of a finalization
        if (recorded.status === "no-ticket")
          await recordFinalResult(client, job.rows[0], result);
      }
      return finished;
    });
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(bundleRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt } = c.req.valid("query");
    const holder = await checkHolder(context.pool, {
      jobId: id,
      workerId,
      attempt,
      now: context.clock(),
    });
    if (holder.status !== "ok") {
      const { body, status } = refusal(holder);
      return c.json(body, status);
    }
    const job = await context.pool.query(
      "SELECT id, attempt, payload FROM jobs WHERE id = $1",
      [id],
    );
    const bundle = await buildBundle(context.pool, job.rows[0]);
    if (!bundle) return c.json({ error: "this job has no ticket" }, 404);
    return c.json(bundle, 200);
  });

  app.openapi(failRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, error } = c.req.valid("json");
    // the job failing and what that means for its ticket happen together or not at all
    const outcome = await inTransaction(context.pool, async (client) => {
      const failed = await failJob(
        client,
        { jobId: id, workerId, attempt, now: context.clock() },
        error,
      );
      if (failed.status === "ok") {
        const job = await client.query(
          "SELECT id, payload FROM jobs WHERE id = $1",
          [id],
        );
        await recordJobFailure(client, job.rows[0], error);
      }
      return failed;
    });
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });
}
