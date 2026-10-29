import { MAX_LOG_CHUNK_BYTES } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { checkHolder } from "../jobs/queue.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const RunId = z.coerce.number().int().min(1).max(INT4_MAX);
const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;

const appendRoute = createRoute({
  method: "post",
  path: "/worker/runs/{id}/logs",
  request: {
    params: z.object({ id: RunId }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            workerId: z.string().min(1).max(200),
            attempt: z.number().int().min(1).max(INT4_MAX),
            chunk: z
              .string()
              .max(MAX_LOG_CHUNK_BYTES)
              .refine(
                (text) => Buffer.byteLength(text) <= MAX_LOG_CHUNK_BYTES,
                {
                  message: "a chunk is at most 1 MiB",
                },
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Appended; size is the log's length in bytes now",
      content: {
        "application/json": { schema: z.object({ size: z.number().int() }) },
      },
    },
    404: {
      description: "No such run",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
    413: {
      description: "The log of this run attempt is full",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/runs/{id}/logs",
  request: {
    params: z.object({ id: RunId }),
    query: z.object({
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_READ_BYTES)
        .default(DEFAULT_READ_BYTES),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX).optional(),
    }),
  },
  responses: {
    200: {
      description:
        "A slice of the log. Continue from nextOffset; when attempt changes, start again from 0",
      content: {
        "application/json": {
          schema: z.object({
            attempt: z.number().int(),
            offset: z.number().int(),
            nextOffset: z.number().int(),
            size: z.number().int(),
            text: z.string(),
            finished: z.boolean(),
          }),
        },
      },
    },
    404: {
      description: "No such run",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

export function registerLogRoutes(app: OpenAPIHono, context: AppContext): void {
  const { pool, logs } = context;

  app.openapi(appendRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, chunk } = c.req.valid("json");
    const run = await pool.query<{ job_id: number | null }>(
      "SELECT job_id FROM runs WHERE id = $1",
      [id],
    );
    if (!run.rows[0]) return c.json({ error: "no such run" }, 404);
    // Only the holder of the run's job, at its current attempt, may write: a worker that woke up after its
    // lease was taken over cannot scribble into the new attempt's log.
    const holder = run.rows[0].job_id
      ? await checkHolder(pool, {
          jobId: run.rows[0].job_id,
          workerId,
          attempt,
          now: context.clock(),
        })
      : ({ status: "stale" } as const);
    if (holder.status !== "ok") {
      return c.json({ error: "stale attempt or lease not held" }, 409);
    }
    const appended = await logs.append(id, attempt, chunk);
    if (appended.status === "too-large") {
      return c.json({ error: "the log of this run is full" }, 413);
    }
    return c.json({ size: appended.size }, 200);
  });

  app.openapi(readRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { offset, limit, attempt: requested } = c.req.valid("query");
    const run = await pool.query<{
      finished_at: Date | null;
      job_attempt: number | null;
    }>(
      `SELECT r.finished_at, j.attempt AS job_attempt FROM runs r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1`,
      [id],
    );
    if (!run.rows[0]) return c.json({ error: "no such run" }, 404);
    // Default to the job's current attempt, so a new attempt that has not written yet does not show the old log.
    const attempt =
      requested ??
      (await logs.latestAttempt(id)) ??
      run.rows[0].job_attempt ??
      1;
    const slice = await logs.read(id, attempt, offset, limit);
    return c.json(
      { attempt, ...slice, finished: run.rows[0].finished_at !== null },
      200,
    );
  });
}
