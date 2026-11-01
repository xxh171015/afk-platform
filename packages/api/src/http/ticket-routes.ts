import { REVIEW_AXES, SPEC_STATES, TICKET_STATES } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AcceptancePack,
  MergeOrderView,
  OrderBroken,
  PullRequestRow,
} from "../acceptance/pack.ts";
import type { AppContext } from "../app.ts";
import { aroundSpec, aroundTicket } from "../events/announce.ts";
import { waiveFinalE2e } from "../finalize/final-e2e.ts";
import { retryFinalization } from "../finalize/finalize.ts";
import {
  allowPaths,
  approveProtected,
  cancelSpec,
  cancelTicket,
  editTicket,
  resumeSpec,
  retrySpecCleanup,
  retryTicket,
} from "../tickets/actions.ts";
import { TIMELINE_KINDS } from "../tickets/timeline.ts";
import {
  blockedQueue,
  runView,
  search,
  specList,
  specView,
  ticketView,
} from "../tickets/views.ts";
import { workbench } from "../tickets/workbench.ts";
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

const IntegrationAttempt = z.object({
  e2e: z.object({
    id: Id,
    displayId: z.string(),
    result: z.string().nullable(),
    testsTotal: Id.nullable(),
    testsFailed: Id.nullable(),
    envUpMs: Id.nullable(),
    refShas: z.record(z.string(), z.string()).nullable(),
    headSha: z.string().nullable(),
  }),
  diagnosis: z
    .object({
      result: z.string().nullable(),
      failingRepo: z.string().nullable(),
      evidence: z.string(),
      failingTests: z.array(z.string()),
    })
    .nullable(),
  fixTicket: z
    .object({
      id: Id,
      displayId: z.string(),
      state: z.enum(TICKET_STATES),
      repo: z.string(),
    })
    .nullable(),
});

const Brief = z
  .object({
    run: z.object({ id: Id, displayId: z.string() }),
    stage: z.string(),
    result: z.string().nullable(),
    output: z.unknown(),
    logPath: z.string(),
    attempts: z.array(IntegrationAttempt).optional(),
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
  refs: z.array(z.string()),
  environment: z.array(z.string()),
  appended: z.boolean(),
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

const RunRow = z.object({
  id: Id,
  displayId: z.string(),
  stage: z.string(),
  attempt: Id,
  result: z.string().nullable(),
  durationMs: Id.nullable(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  skillsSha: z.string().nullable(),
  axis: z.enum(REVIEW_AXES).nullable(),
  cursorCliVersion: z.string().nullable(),
  contractShas: z.record(z.string(), z.string()).nullable(),
  refShas: z.record(z.string(), z.string()).nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const RunView = RunRow.extend({
  specId: Id,
  specDisplayId: z.string(),
  ticketId: Id.nullable(),
  ticketDisplayId: z.string().nullable(),
});

const ticketRoute = createRoute({
  method: "get",
  path: "/tickets/{id}",
  request: {
    params: z.object({ id: PathId }),
    // an older version of the content, as it was kept when the ticket was edited
    query: z.object({
      version: z.coerce.number().int().min(1).max(INT4_MAX).optional(),
    }),
  },
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
          // The ticket as one markdown file, as the agent reads it (also /context/ticket.md).
          file: z.string(),
          contractSha: z.string().nullable(),
          fixCounts: z.record(z.string(), Id),
          reviewed: z.boolean(),
        }),
        integration: z
          .object({
            rounds: Id,
            attempts: z.array(IntegrationAttempt),
          })
          .nullable(),
        versions: z.array(z.object({ version: Id, createdAt: z.string() })),
        upstream: z.array(EdgeEnd),
        downstream: z.array(EdgeEnd),
        runs: z.array(RunRow),
        findings: z.array(
          z.object({
            id: Id,
            runId: Id,
            kind: z.string(),
            body: z.string(),
            resolution: z.string(),
            axis: z.enum(REVIEW_AXES).nullable(),
          }),
        ),
        gateResults: z.array(
          z.object({
            kind: z.enum(["gate", "e2e"]),
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

const runRoute = createRoute({
  method: "get",
  path: "/runs/{id}",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply("The run: stage, attempt, result and duration", RunView),
    404: reply("No such run", ErrorReply),
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
          projectId: Id,
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
          planningSha: z.string().nullable(),
          planningRepo: z.string().nullable(),
          prechecks: z.array(
            z.object({
              code: z.string(),
              level: z.literal("yellow"),
              message: z.string(),
            }),
          ),
        }),
        tickets: z.array(TicketSummary),
        finalizations: z.array(Finalization),
        mergeOrder: MergeOrderView,
        orderBroken: OrderBroken,
        pullRequests: z.array(PullRequestRow),
        acceptancePack: AcceptancePack.nullable(),
        edges: z.array(
          z.object({ from: z.string(), to: z.string(), kind: z.string() }),
        ),
        timeline: z.array(
          z.object({
            kind: z.enum(TIMELINE_KINDS),
            at: z.string(),
            text: z.string(),
            runId: Id.optional(),
            ticketId: Id.optional(),
          }),
        ),
        finalRuns: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            repo: z.string(),
            stage: z.string(),
            result: z.string().nullable(),
          }),
        ),
      }),
    ),
    404: reply("No such spec", ErrorReply),
  },
});

const SpecListItem = z.object({
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
});

const specsRoute = createRoute({
  method: "get",
  path: "/specs",
  responses: {
    200: reply(
      "Every spec, newest first, with the progress of its tickets",
      z.object({
        specs: z.array(SpecListItem),
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

const BlockedQueue = z.object({
  tickets: z.array(TicketSummary),
  finalizations: z.array(Finalization),
  pullRequests: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      repo: z.string(),
      number: z.number().int(),
      url: z.string(),
      state: z.string(),
      syncError: z.string().nullable(),
    }),
  ),
  cleanups: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      error: z.string(),
    }),
  ),
  readyFailures: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      repo: z.string(),
      number: z.number().int(),
      url: z.string(),
      error: z.string(),
    }),
  ),
  specs: z.array(
    z.object({
      id: Id,
      displayId: z.string(),
      title: z.string(),
      reason: z.string(),
    }),
  ),
});

const blockedRoute = createRoute({
  method: "get",
  path: "/blocked",
  responses: {
    200: reply(
      "Blocked tickets, stuck pull requests, cleanups that failed and paused specs, everything waiting for a person",
      BlockedQueue,
    ),
  },
});

const RunningTicket = z.object({
  id: Id,
  displayId: z.string(),
  title: z.string(),
  state: z.enum(TICKET_STATES),
  repo: z.string(),
  stage: z.string().nullable(),
  startedAt: z.string().nullable(),
  elapsedMs: z.number().int().nullable(),
  meanMs: z.number().int().nullable(),
  slow: z.boolean(),
});

const workbenchRoute = createRoute({
  method: "get",
  path: "/workbench",
  responses: {
    200: reply(
      "The four workbench quadrants: waiting, running, awaiting acceptance, recently merged",
      z.object({
        waiting: BlockedQueue,
        running: z.array(
          z.object({ spec: SpecListItem, tickets: z.array(RunningTicket) }),
        ),
        awaitingAcceptance: z.array(
          z.object({
            spec: SpecListItem,
            pullRequestCount: Id,
            verifiedCriteria: Id,
            totalCriteria: Id,
          }),
        ),
        recentlyCompleted: z.array(
          z.object({ spec: SpecListItem, completedAt: z.string() }),
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

const editRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/edit",
  request: {
    params: z.object({ id: PathId }),
    // A ticket file, as `plat ticket view --md` prints it: only the title, body, modules and approved protected
    // paths can change; the other fields may be left out, and written must say what the ticket has.
    body: { content: json(z.strictObject({ file: z.string() })) },
  },
  responses: {
    200: reply(
      "Edited (the content version went up by one), or the file said what the ticket already has (changed: false)",
      z.object({ id: Id, contentVersion: Id, changed: z.boolean() }),
    ),
    404: reply("No such ticket", ErrorReply),
    409: reply("The ticket is not pending or blocked", ErrorReply),
    422: reply(
      "The file is not a valid ticket file, or changes something that cannot be changed",
      ErrorReply,
    ),
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

const allowPathsRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/allow-paths",
  request: {
    params: z.object({ id: PathId }),
    body: {
      content: json(z.object({ paths: z.array(z.string().min(1)).min(1) })),
    },
  },
  responses: {
    200: reply(
      "The ticket's approved protected paths now",
      z.object({ allowed: z.array(z.string()) }),
    ),
    404: reply("No such ticket", ErrorReply),
    409: reply("Only a blocked ticket can be given paths", ErrorReply),
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

const cancelSpecRoute = createRoute({
  method: "post",
  path: "/specs/{id}/cancel",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The spec is cancelled, with the tickets that went with it and the pull requests last seen open on the code host, which a worker with the code host then closes",
      z.object({
        state: z.enum(SPEC_STATES),
        cancelled: z.array(z.string()),
        pullRequests: z.array(
          z.object({
            repo: z.string(),
            number: z.number().int(),
            url: z.string(),
          }),
        ),
      }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply(
      "The spec is merged or already cancelled, or one of its pull requests is merged",
      ErrorReply,
    ),
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

const waiveFinalRoute = createRoute({
  method: "post",
  path: "/specs/{id}/final/waive",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The pull requests go out although the e2e before them failed; the acceptance pack says so",
      z.object({ waived: z.literal(true) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("No e2e is blocked", ErrorReply),
  },
});

const retryCleanupRoute = createRoute({
  method: "post",
  path: "/specs/{id}/cleanup",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "The clean-up (closing its pull requests, deleting its branches) is queued again",
      z.object({ queued: z.literal(true) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply(
      "The spec is not cancelled or merged, or a clean-up of it is already waiting",
      ErrorReply,
    ),
  },
});

export function registerTicketRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(ticketRoute, async (c) => {
    const view = await ticketView(
      pool,
      c.req.valid("param").id,
      c.req.valid("query").version,
    );
    return view
      ? c.json(view, 200)
      : c.json({ error: "no such ticket or version" }, 404);
  });

  app.openapi(runRoute, async (c) => {
    const view = await runView(pool, c.req.valid("param").id);
    return view ? c.json(view, 200) : c.json({ error: "no such run" }, 404);
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

  app.openapi(workbenchRoute, async (c) =>
    c.json(await workbench(pool, context.clock()), 200),
  );

  app.openapi(retryRoute, async (c) => {
    const result = await aroundTicket(context, c.req.valid("param").id, () =>
      retryTicket(pool, c.req.valid("param").id, c.req.valid("json").mode),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ state: result.state }, 200);
  });

  app.openapi(approveRoute, async (c) => {
    const result = await aroundTicket(context, c.req.valid("param").id, () =>
      approveProtected(pool, c.req.valid("param").id),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ approved: result.approved }, 200);
  });

  app.openapi(editRoute, async (c) => {
    const { id } = c.req.valid("param");
    const result = await aroundTicket(context, id, () =>
      editTicket(pool, id, c.req.valid("json").file),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    if (result.status === "invalid")
      return c.json({ error: result.message }, 422);
    return c.json(
      { id, contentVersion: result.contentVersion, changed: result.changed },
      200,
    );
  });

  app.openapi(allowPathsRoute, async (c) => {
    const result = await aroundTicket(context, c.req.valid("param").id, () =>
      allowPaths(pool, c.req.valid("param").id, c.req.valid("json").paths),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such ticket" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ allowed: result.allowed }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const result = await aroundTicket(context, c.req.valid("param").id, () =>
      cancelTicket(pool, c.req.valid("param").id, c.req.valid("json").cascade),
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
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      resumeSpec(
        pool,
        c.req.valid("param").id,
        c.req.valid("json").extraSeconds,
      ),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ state: result.state }, 200);
  });

  app.openapi(cancelSpecRoute, async (c) => {
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      cancelSpec(pool, c.req.valid("param").id, context.clock()),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json(
      {
        state: result.state,
        cancelled: result.cancelled,
        pullRequests: result.pullRequests,
      },
      200,
    );
  });

  app.openapi(retryFinalRoute, async (c) => {
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      retryFinalization(pool, c.req.valid("param").id),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ retried: result.retried }, 200);
  });

  app.openapi(waiveFinalRoute, async (c) => {
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      waiveFinalE2e(pool, c.req.valid("param").id),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ waived: true as const }, 200);
  });

  app.openapi(retryCleanupRoute, async (c) => {
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      retrySpecCleanup(pool, c.req.valid("param").id),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ queued: true as const }, 200);
  });
}
