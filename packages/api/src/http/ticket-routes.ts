import { SPEC_STATES, TICKET_STATES } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../app.ts";
import { retryFinalization } from "../finalize/finalize.ts";
import {
  approveProtected,
  cancelTicket,
  resumeSpec,
  retryTicket,
} from "../tickets/actions.ts";
import {
  blockedQueue,
  search,
  specList,
  specView,
  ticketView,
} from "../tickets/views.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const Id = z.number().int();
const PathId = z.coerce.number().int().min(1).max(INT4_MAX);
const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const Brief = z
  .object({
    run: z.object({ id: Id, displayId: z.string() }),
    stage: z.string(),
    result: z.string().nullable(),
    output: z.unknown(),
    logPath: z.string(),
  })
  .nullable();

const TicketSummary = z.object({
  id: Id,
  displayId: z.string(),
  specId: Id,
  specDisplayId: z.string(),
  title: z.string(),
  type: z.string(),
  state: z.enum(TICKET_STATES),
  blockedReason: z.string().nullable(),
  repo: z.string(),
  brief: Brief,
});

const Finalization = z.object({
  specId: Id,
  specDisplayId: z.string(),
  repo: z.string(),
  step: z.string(),
  state: z.string(),
  blockedReason: z.string().nullable(),
  brief: Brief,
});

const EdgeEnd = z.object({
  id: Id,
  displayId: z.string(),
  kind: z.string(),
  state: z.enum(TICKET_STATES),
});

const ticketRoute = createRoute({
  method: "get",
  path: "/tickets/{id}",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The ticket, its runs, findings and gate results",
      z.object({
        ticket: TicketSummary.extend({
          body: z.string(),
          acceptanceCriteria: z.array(z.string()),
          modules: z.array(z.string()),
          allowedProtectedPaths: z.array(z.string()),
          contentVersion: Id,
          contractSha: z.string().nullable(),
          fixCounts: z.record(z.string(), Id),
          reviewed: z.boolean(),
        }),
        upstream: z.array(EdgeEnd),
        downstream: z.array(EdgeEnd),
        runs: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            stage: z.string(),
            attempt: Id,
            result: z.string().nullable(),
            durationMs: Id.nullable(),
            agent: z.string().nullable(),
            model: z.string().nullable(),
            skillsSha: z.string().nullable(),
            cursorCliVersion: z.string().nullable(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
          }),
        ),
        findings: z.array(
          z.object({
            id: Id,
            runId: Id,
            kind: z.string(),
            body: z.string(),
            resolution: z.string(),
          }),
        ),
        gateResults: z.array(
          z.object({
            commitSha: z.string(),
            configSha: z.string(),
            commandResults: z.array(z.unknown()),
            testsTotal: Id.nullable(),
            testsSkipped: Id.nullable(),
          }),
        ),
      }),
    ),
    404: reply("No such ticket", ErrorReply),
  },
});

const specRoute = createRoute({
  method: "get",
  path: "/specs/{id}",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The spec with its tickets and dependency edges",
      z.object({
        spec: z.object({
          id: Id,
          displayId: z.string(),
          slug: z.string(),
          title: z.string(),
          type: z.string(),
          body: z.string(),
          state: z.enum(SPEC_STATES),
          pauseReason: z.string().nullable(),
          integrationBranches: z.array(
            z.object({ repoId: Id, branch: z.string() }),
          ),
          warnings: z.array(z.unknown()),
        }),
        tickets: z.array(TicketSummary),
        finalizations: z.array(Finalization),
        edges: z.array(
          z.object({ from: z.string(), to: z.string(), kind: z.string() }),
        ),
      }),
    ),
    404: reply("No such spec", ErrorReply),
  },
});

const specsRoute = createRoute({
  method: "get",
  path: "/specs",
  responses: {
    200: reply(
      "Every spec, newest first, with the progress of its tickets",
      z.object({
        specs: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            slug: z.string(),
            title: z.string(),
            type: z.string(),
            state: z.enum(SPEC_STATES),
            pauseReason: z.string().nullable(),
            project: z.string(),
            progress: z.object({
              total: Id,
              done: Id,
              active: Id,
              blocked: Id,
              pending: Id,
              cancelled: Id,
            }),
          }),
        ),
      }),
    ),
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  request: {
    query: z.object({
      q: z.string().trim().min(1).max(200),
    }),
  },
  responses: {
    200: reply(
      "Specs and tickets whose number, title or body contains the text, ignoring case",
      z.object({
        specs: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            title: z.string(),
            state: z.enum(SPEC_STATES),
            matched: z.array(z.enum(["id", "title", "body"])),
          }),
        ),
        tickets: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            title: z.string(),
            state: z.enum(TICKET_STATES),
            specId: Id,
            specDisplayId: z.string(),
            matched: z.array(z.enum(["id", "title", "body"])),
          }),
        ),
      }),
    ),
  },
});

const blockedRoute = createRoute({
  method: "get",
  path: "/blocked",
  responses: {
    200: reply(
      "Blocked tickets and paused specs, everything waiting for a person",
      z.object({
        tickets: z.array(TicketSummary),
        finalizations: z.array(Finalization),
        specs: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            title: z.string(),
            reason: z.string(),
          }),
        ),
      }),
    ),
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/retry",
  request: {
    params: z.object({ id: PathId }),
    body: {
      content: json(z.object({ mode: z.enum(["continue", "restart"]) })),
    },
  },
  responses: {
    200: reply(
      "Back to pending (or already queued again)",
      z.object({ state: z.enum(TICKET_STATES) }),
    ),
    404: reply("No such ticket", ErrorReply),
    409: reply("The ticket is not blocked", ErrorReply),
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/approve-protected",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "Approved; the ticket goes on from the gate",
      z.object({ approved: z.array(z.string()) }),
    ),
    404: reply("No such ticket", ErrorReply),
    409: reply(
      "The ticket is not blocked by protected-path-changed",
      ErrorReply,
    ),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/cancel",
  request: {
    params: z.object({ id: PathId }),
    body: { content: json(z.object({ cascade: z.boolean().default(false) })) },
  },
  responses: {
    200: reply(
      "Cancelled",
      z.object({
        cancelled: z.array(z.string()),
        blocked: z.array(z.string()),
        skipped: z.array(z.string()),
      }),
    ),
    404: reply("No such ticket", ErrorReply),
    409: reply("Only a pending or blocked ticket can be cancelled", ErrorReply),
  },
});

const resumeRoute = createRoute({
  method: "post",
  path: "/specs/{id}/resume",
  request: {
    params: z.object({ id: PathId }),
    body: {
      content: json(
        z.object({
          extraSeconds: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 3600),
        }),
      ),
    },
  },
  responses: {
    200: reply(
      "Running again, with the extra agent time",
      z.object({ state: z.enum(SPEC_STATES) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The spec is not paused", ErrorReply),
  },
});

const retryFinalRoute = createRoute({
  method: "post",
  path: "/specs/{id}/final/retry",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The blocked steps of the overall review are queued again",
      z.object({ retried: z.array(z.string()) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("Nothing is blocked", ErrorReply),
  },
});

export function registerTicketRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(ticketRoute, async (c) => {
    const view = await ticketView(pool, c.req.valid("param").id);
    return view ? c.json(view, 200) : c.json({ error: "no such ticket" }, 404);
  });

  app.openapi(specRoute, async (c) => {
    const view = await specView(pool, c.req.valid("param").id);
    return view ? c.json(view, 200) : c.json({ error: "no such spec" }, 404);
  });

  app.openapi(specsRoute, async (c) =>
    c.json({ specs: await specList(pool) }, 200),
  );

  app.openapi(searchRoute, async (c) =>
    c.json(await search(pool, c.req.valid("query").q), 200),
  );

  app.openapi(blockedRoute, async (c) => c.json(await blockedQueue(pool), 200));

  app.openapi(retryRoute, async (c) => {
    const result = await retryTicket(
      pool,
      c.req.valid("param").id,
      c.req.valid("json").mode,
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ state: result.state }, 200);
  });

  app.openapi(approveRoute, async (c) => {
    const result = await approveProtected(pool, c.req.valid("param").id);
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ approved: result.approved }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const result = await cancelTicket(
      pool,
      c.req.valid("param").id,
      c.req.valid("json").cascade,
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json(
      {
        cancelled: result.cancelled,
        blocked: result.blocked,
        skipped: result.skipped,
      },
      200,
    );
  });

  app.openapi(resumeRoute, async (c) => {
    const result = await resumeSpec(
      pool,
      c.req.valid("param").id,
      c.req.valid("json").extraSeconds,
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ state: result.state }, 200);
  });

  app.openapi(retryFinalRoute, async (c) => {
    const result = await retryFinalization(pool, c.req.valid("param").id);
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ retried: result.retried }, 200);
  });
}
