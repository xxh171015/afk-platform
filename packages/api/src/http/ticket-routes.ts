import {
  FAILURE_SOURCES,
  HOST_KINDS,
  PLANNING_STATES,
  REVIEW_AXES,
  SPEC_STATES,
  TICKET_STATES,
} from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AcceptancePack,
  MergeOrderView,
  OrderBroken,
  PullRequestRow,
} from "../acceptance/pack.ts";
import { agentsPause, resumeAgents } from "../agents-pause.ts";
import type { AppContext } from "../app.ts";
import { refreshDiskStatus } from "../disk.ts";
import { aroundSpec, aroundTicket } from "../events/announce.ts";
import { waiveFinalE2e } from "../finalize/final-e2e.ts";
import { retryFinalization } from "../finalize/finalize.ts";
import {
  allowPaths,
  allowSpec,
  approveProtected,
  cancelSpec,
  cancelTicket,
  editTicket,
  parkedRetryNote,
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

const StructuredBrief = z
  .object({
    reason: z.string(),
    step: z.string(),
    summary: z.string(),
    evidence: z.object({
      failingTests: z.array(z.string()).optional(),
      command: z.string().optional(),
      lastLogLines: z.string().optional(),
      conflictFiles: z.array(z.string()).optional(),
      findingsCount: z.number().int().optional(),
    }),
    recommendedAction: z.string(),
    commands: z.array(
      z.object({
        label: z.string(),
        command: z.string(),
      }),
    ),
    ticketDraft: z.string().optional(),
  })
  .nullable();

const RepoIdentity = z.object({
  name: z.string(),
  url: z.string(),
  hostKind: z.enum(HOST_KINDS),
});

const Blocking = z.object({
  downstream: z.array(z.string()),
  finalization: z.boolean(),
  pullRequests: z.boolean(),
  spec: z.boolean(),
  merge: z.boolean(),
});

const WaitingFields = z.object({
  waitingSince: z.string().optional(),
  blocking: Blocking.optional(),
  // whose fault it is: the platform's and outside services' problems are listed after the specs' own
  failureSource: z.enum(FAILURE_SOURCES).nullable().optional(),
});

const WaitingRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), id: Id }),
  z.object({ kind: z.literal("finalization"), id: Id, step: z.string() }),
  z.object({
    kind: z.literal("pullRequest"),
    specId: Id,
    repo: z.string(),
    number: z.number().int(),
  }),
  z.object({ kind: z.literal("cleanup"), specId: Id }),
  z.object({
    kind: z.literal("readyFailure"),
    specId: Id,
    repo: z.string(),
    number: z.number().int(),
  }),
  z.object({ kind: z.literal("planning"), specId: Id }),
  z.object({ kind: z.literal("pausedSpec"), id: Id }),
]);

const TicketSummary = z
  .object({
    id: Id,
    displayId: z.string(),
    specId: Id,
    specDisplayId: z.string(),
    title: z.string(),
    type: z.string(),
    state: z.enum(TICKET_STATES),
    blockedReason: z.string().nullable(),
    repo: z.string(),
    repoUrl: z.string(),
    hostKind: z.enum(HOST_KINDS),
    refs: z.array(z.string()),
    environment: z.array(z.string()),
    appended: z.boolean(),
    brief: Brief,
    structuredBrief: StructuredBrief,
  })
  .merge(WaitingFields);

const Finalization = z
  .object({
    id: Id,
    specId: Id,
    specDisplayId: z.string(),
    repo: z.string(),
    step: z.string(),
    state: z.string(),
    blockedReason: z.string().nullable(),
    brief: Brief,
    structuredBrief: StructuredBrief,
    hostKind: z.enum(HOST_KINDS).optional(),
  })
  .merge(WaitingFields);

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
  // Run prompt / Structured output / commits: only on this detail. Ticket runs tables stay thin
  // (docs/specs/experience-platform.md「Run 页签」).
  prompt: z.string().nullable(),
  output: z.unknown().nullable(),
  commits: z.array(z.string()),
  // the standards-source files a Standards review used; null on every other Run
  sources: z.array(z.string()).nullable(),
  repoUrl: z.string(),
  hostKind: z.enum(HOST_KINDS),
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
    200: reply(
      "The run: stage, attempt, result, duration, prompt, structured output and commits",
      RunView,
    ),
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
          repos: z.array(RepoIdentity),
          integrationBranches: z.array(
            z.object({
              repoId: Id,
              branch: z.string(),
              name: z.string(),
              url: z.string(),
              hostKind: z.enum(HOST_KINDS),
            }),
          ),
          warnings: z.array(z.unknown()),
          planningSha: z.string().nullable(),
          planningRepo: z.string().nullable(),
          // the planning commit (ADR 0005): repo is the spec's planning repo, null when it was not made in one
          planning: z.object({
            repo: z.string().nullable(),
            state: z.enum(PLANNING_STATES).nullable(),
            sha: z.string().nullable(),
            conflict: z.array(z.string()),
          }),
          prechecks: z.array(
            z.object({
              code: z.string(),
              level: z.literal("yellow"),
              message: z.string(),
            }),
          ),
          tokenMerged: z.boolean(),
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
            failureSource: z.enum(FAILURE_SOURCES).optional(),
          }),
        ),
        // true when this spec has no events and the timeline is the old domain-table assembly
        timelineLegacy: z.boolean(),
        finalRuns: z.array(
          z.object({
            id: Id,
            displayId: z.string(),
            repo: z.string(),
            stage: z.string(),
            // which axis of a final review (standards | spec), null for the other steps
            axis: z.string().nullable(),
            // null while the Run is going
            result: z.string().nullable(),
            durationMs: Id.nullable(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
          }),
        ),
        potentialConflicts: z.array(
          z.object({
            specId: Id,
            displayId: z.string(),
            title: z.string(),
            repo: z.string(),
            repoId: Id,
            files: z.array(z.string()),
          }),
        ),
        leadTime: z
          .object({
            agentMs: z.number().int(),
            gateMs: z.number().int(),
            queuedMs: z.number().int(),
            waitingMs: z.number().int(),
            totalMs: z.number().int(),
          })
          .nullable(),
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
  repos: z.array(RepoIdentity),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
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
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).optional(),
      q: z.string().trim().min(1).max(200).optional(),
      state: z
        .union([z.enum(SPEC_STATES), z.array(z.enum(SPEC_STATES))])
        .optional(),
      repo: z.string().trim().min(1).max(200).optional(),
      sort: z.enum(["startedAt", "state", "progress"]).optional(),
      dir: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: reply(
      "A page of specs, newest first unless sort says otherwise, with the progress of their tickets",
      z.object({
        specs: z.array(SpecListItem),
        nextCursor: z.string().nullable(),
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
    z
      .object({
        specId: Id,
        specDisplayId: z.string(),
        repo: z.string(),
        number: z.number().int(),
        url: z.string(),
        state: z.string(),
        syncError: z.string().nullable(),
        hostKind: z.enum(HOST_KINDS).optional(),
      })
      .merge(WaitingFields),
  ),
  cleanups: z.array(
    z
      .object({
        specId: Id,
        specDisplayId: z.string(),
        error: z.string(),
        hostKind: z.enum(HOST_KINDS).optional(),
      })
      .merge(WaitingFields),
  ),
  readyFailures: z.array(
    z
      .object({
        specId: Id,
        specDisplayId: z.string(),
        repo: z.string(),
        number: z.number().int(),
        url: z.string(),
        error: z.string(),
        hostKind: z.enum(HOST_KINDS).optional(),
      })
      .merge(WaitingFields),
  ),
  // planning docs that did not apply (ADR 0005): a person retries or waives them
  planning: z.array(
    z
      .object({
        specId: Id,
        specDisplayId: z.string(),
        title: z.string(),
        repo: z.string(),
        files: z.array(z.string()),
      })
      .merge(WaitingFields),
  ),
  specs: z.array(
    z
      .object({
        id: Id,
        displayId: z.string(),
        title: z.string(),
        reason: z.string(),
      })
      .merge(WaitingFields),
  ),
  items: z.array(WaitingRef),
});

const WorkbenchWaiting = z.object({
  tickets: z.array(
    z.object({
      id: Id,
      displayId: z.string(),
      specId: Id,
      title: z.string(),
      blockedReason: z.string().nullable(),
    }),
  ),
  finalizations: z.array(
    z.object({
      id: Id,
      specId: Id,
      specDisplayId: z.string(),
      step: z.string(),
      blockedReason: z.string().nullable(),
    }),
  ),
  pullRequests: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      repo: z.string(),
      number: z.number().int(),
    }),
  ),
  cleanups: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
    }),
  ),
  readyFailures: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      repo: z.string(),
      number: z.number().int(),
    }),
  ),
  planning: z.array(
    z.object({
      specId: Id,
      specDisplayId: z.string(),
      title: z.string(),
    }),
  ),
  specs: z.array(
    z.object({
      id: Id,
      displayId: z.string(),
      title: z.string(),
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

const WorkbenchStatus = z.object({
  // set while the agents' provider refuses work and no agent job is claimed
  agentsPaused: z.object({ since: z.string(), reason: z.string() }).nullable(),
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
});

const workbenchRoute = createRoute({
  method: "get",
  path: "/workbench",
  responses: {
    200: reply(
      "The four workbench quadrants plus the status area (disk, workers, last cleanup)",
      z.object({
        waiting: WorkbenchWaiting,
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
        status: WorkbenchStatus,
      }),
    ),
  },
});

const resumeAgentsRoute = createRoute({
  method: "post",
  path: "/agents/resume",
  responses: {
    200: reply(
      "Agent jobs are claimed again; resumed is false when they were not paused",
      z.object({ resumed: z.boolean() }),
    ),
  },
});

const RetryNote = z.string().optional();

const retryRoute = createRoute({
  method: "post",
  path: "/tickets/{id}/retry",
  request: {
    params: z.object({ id: PathId }),
    body: {
      content: json(
        z.object({
          mode: z.enum(["continue", "restart"]),
          note: RetryNote,
        }),
      ),
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
            .max(7 * 24 * 3600)
            .optional(),
        }),
      ),
    },
  },
  responses: {
    200: reply(
      "Running again; extraSeconds adds agent time when the budget ran out",
      z.object({ state: z.enum(SPEC_STATES) }),
    ),
    404: reply("No such spec", ErrorReply),
    409: reply("The spec is not paused", ErrorReply),
  },
});

const allowSpecRoute = createRoute({
  method: "post",
  path: "/specs/{id}/allow",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "Running again without extra agent time",
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
  request: {
    params: z.object({ id: PathId }),
    body: {
      content: json(z.object({ note: RetryNote })),
      required: false,
    },
  },
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
    const view = await specView(pool, c.req.valid("param").id, context.clock());
    return view ? c.json(view, 200) : c.json({ error: "no such spec" }, 404);
  });

  app.openapi(specsRoute, async (c) => {
    const query = c.req.valid("query");
    const states =
      query.state === undefined
        ? undefined
        : Array.isArray(query.state)
          ? query.state
          : [query.state];
    return c.json(
      await specList(pool, {
        limit: query.limit,
        cursor: query.cursor,
        q: query.q,
        states,
        repo: query.repo,
        sort: query.sort,
        dir: query.dir,
      }),
      200,
    );
  });

  app.openapi(searchRoute, async (c) =>
    c.json(await search(pool, c.req.valid("query").q), 200),
  );

  app.openapi(blockedRoute, async (c) => c.json(await blockedQueue(pool), 200));

  app.openapi(workbenchRoute, async (c) => {
    const board = await workbench(pool, context.clock());
    const sample = await context.statDisk(context.logDir);
    const status = await refreshDiskStatus(pool, sample, (notice) =>
      context.notifications.notify(notice),
    );
    const agentsPaused = await agentsPause(pool);
    return c.json({ ...board, status: { ...status, agentsPaused } }, 200);
  });

  app.openapi(resumeAgentsRoute, async (c) =>
    c.json({ resumed: await resumeAgents(pool) }, 200),
  );

  app.openapi(retryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { mode, note } = c.req.valid("json");
    const result = await aroundTicket(context, id, () =>
      retryTicket(pool, id, mode, note),
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
        c.req.valid("json").extraSeconds ?? 0,
      ),
    );
    if (result.status === "no-ticket")
      return c.json({ error: "no such spec" }, 404);
    if (result.status === "refused")
      return c.json({ error: result.message }, 409);
    return c.json({ state: result.state }, 200);
  });

  app.openapi(allowSpecRoute, async (c) => {
    const result = await aroundSpec(context, c.req.valid("param").id, () =>
      allowSpec(pool, c.req.valid("param").id),
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
    const { id } = c.req.valid("param");
    let note: string | undefined;
    try {
      note = c.req.valid("json")?.note;
    } catch {
      note = undefined;
    }
    const result = await aroundSpec(context, id, () =>
      retryFinalization(pool, id, parkedRetryNote(note)),
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
