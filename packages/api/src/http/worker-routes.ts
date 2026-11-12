import { HOST_KINDS, REVIEW_AXES, TICKET_REVIEW_MODES } from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type pg from "pg";
import { pauseForProvider } from "../agents-pause.ts";
import type { AppContext } from "../app.ts";
import { claimsStopped, refreshDiskStatus } from "../disk.ts";
import {
  aroundJob,
  emitTransition,
  snapshotSpecs,
  specIdsOfJob,
} from "../events/announce.ts";
import { applyOrigin, withOrigin } from "../events/origin.ts";
import {
  readFinalE2ePayload,
  recordFinalE2eResult,
} from "../finalize/final-e2e.ts";
import { markFinalClaimed, recordFinalResult } from "../finalize/finalize.ts";
import { reportHosts } from "../host/code-hosts.ts";
import {
  readHostSyncPayload,
  readIndexPrLinksPayload,
  readOpenPrPayload,
  readPatchPrBodyPayload,
  readPrReadyPayload,
  readSpecCleanupPayload,
} from "../host/host-jobs.ts";
import {
  buildHostTask,
  hostSyncFailed,
  recordHostSync,
  recordIndexPrLinks,
  recordOpenPr,
  recordPrReady,
  recordSpecCleanup,
} from "../host/pull-requests.ts";
import {
  readRepoAccessPayload,
  recordRepoAccess,
  repoAccessFailed,
  repoAccessTask,
} from "../host/repo-access.ts";
import {
  buildTrialMergeTask,
  readTrialMergePayload,
  recordTrialMergeResult,
} from "../host/trial-merge.ts";
import {
  markUpdateBranchClaimed,
  recordUpdateBranchResult,
} from "../host/update-branch.ts";
import {
  checkBeforePush,
  checkHolder,
  claimJob,
  completeJob,
  expiredJobIds,
  failExpiredJob,
  failJob,
  type HolderOutcome,
  heartbeat,
  isLeaseLive,
} from "../jobs/queue.ts";
import {
  markLocateClaimed,
  readLocatePayload,
  recordLocateResult,
} from "../planning/locate-bug.ts";
import {
  buildPlanningTask,
  readPlanningPayload,
  recordPlanningResult,
} from "../planning/planning-commit.ts";
import {
  readinessGateTask,
  readReadinessGatePayload,
} from "../planning/readiness-gate.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import { buildBundle } from "../stages/bundle.ts";
import { LEASE_EXPIRED_ERROR, recordJobFailure } from "../stages/failures.ts";
import { findPassingGate } from "../stages/gate-records.ts";
import { markClaimed, recordStageResult } from "../stages/results.ts";
import { recordWorkerCleanup } from "../workers.ts";
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

const hostsReportRoute = createRoute({
  method: "post",
  path: "/worker/hosts",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            workerId: z.string().min(1).max(200),
            hosts: z
              .array(
                z.object({
                  host: z.string().min(1).max(253),
                  kind: z.enum(HOST_KINDS),
                }),
              )
              .max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Kept: repos on these hosts can be registered and worked on",
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true) }) },
      },
    },
  },
});

const workerStatusRoute = createRoute({
  method: "post",
  path: "/worker/status",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            workerId: z.string().min(1).max(200),
            cleaned: z.object({
              sandboxLogs: z.number().int().min(0),
              salvage: z.number().int().min(0),
              snapshots: z.number().int().min(0),
            }),
            freeBytes: z.number().nonnegative().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Kept for the workbench status area",
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true) }) },
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
      // The ticket as one markdown file: what the agent reads as /context/ticket.md.
      file: z.string(),
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
    name: z.string(),
    url: z.string(),
    defaultBranch: z.string(),
  }),
  domain: z
    .object({
      repo: z.string(),
      url: z.string(),
      defaultBranch: z.string(),
      sha: z.string(),
    })
    .nullable(),
  integrationBranch: z.string().nullable(),
  // The branch the stage's work is made on: the ticket's own, or the one of the spec's overall fix.
  agentBranch: z.string(),
  protectedPaths: z.array(z.string()),
  allowedProtectedPaths: z.array(z.string()),
  contracts: z.array(
    z.object({
      repo: z.string(),
      url: z.string(),
      defaultBranch: z.string(),
      sha: z.string(),
      path: z.string(),
    }),
  ),
  refs: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      defaultBranch: z.string(),
      sha: z.string().nullable(),
    }),
  ),
  environment: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      defaultBranch: z.string(),
      sha: z.string().nullable(),
    }),
  ),
  note: z.string().nullable(),
  failureLog: z.string().nullable(),
  review: z.unknown(),
  gateBaseline: z
    .object({ tests: z.number().int(), skipped: z.number().int() })
    .nullable(),
  gateBaselines: z.array(
    z.object({
      sha: z.string(),
      tests: z.number().int(),
      skipped: z.number().int(),
    }),
  ),
  limits: z.object({
    runIdleSeconds: z.number().int(),
    runWallclockSeconds: z.number().int(),
    maxIntegrationEnvironments: z.number().int(),
  }),
  model: z.string().nullable(),
  ticketReview: z.enum(TICKET_REVIEW_MODES),
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

const HostTask = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open-pr"),
    repoUrl: z.string(),
    base: z.string(),
    head: z.string(),
    title: z.string(),
    body: z.string(),
    draft: z.boolean(),
  }),
  z.object({
    kind: z.literal("host-sync"),
    pulls: z.array(
      z.object({
        id: z.number().int(),
        repoUrl: z.string(),
        number: z.number().int(),
      }),
    ),
    defaults: z
      .array(z.object({ repoUrl: z.string(), branch: z.string() }))
      .optional(),
    ticketBranches: z
      .array(
        z.object({
          ticketId: z.number().int(),
          repoUrl: z.string(),
          branch: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("pr-ready"),
    pull: z.object({
      id: z.number().int(),
      repoUrl: z.string(),
      number: z.number().int(),
    }),
  }),
  z.object({
    kind: z.literal("spec-cleanup"),
    pulls: z.array(
      z.object({
        id: z.number().int(),
        repoUrl: z.string(),
        number: z.number().int(),
      }),
    ),
    branches: z.array(z.object({ repoUrl: z.string(), branch: z.string() })),
  }),
  z.object({
    kind: z.literal("patch-pr-body"),
    repoUrl: z.string(),
    number: z.number().int(),
    section: z.string(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("repo-access"),
    repoUrl: z.string(),
  }),
  z.object({
    kind: z.literal("index-pr-links"),
    repoUrl: z.string(),
    repoName: z.string(),
    defaultBranch: z.string(),
    number: z.number().int(),
    mergeSha: z.string().nullable(),
    squashSha: z.string().nullable(),
  }),
]);

const hostTaskRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/host-task",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({
      workerId: z.string().min(1).max(200),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: {
      description:
        "What an open-pr, host-sync, pr-ready, spec-cleanup, patch-pr-body, repo-access or index-pr-links job has to do on the code host",
      content: { "application/json": { schema: HostTask } },
    },
    404: {
      description: "No such job, or not a job for the code host",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

const readinessTaskRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/readiness-task",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({
      workerId: z.string().min(1).max(200),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: {
      description:
        "What a readiness-gate job has to do: run the repo's gate on the branch, with that branch's gates.yaml (plat repo check)",
      content: {
        "application/json": {
          schema: z.object({
            repo: z.object({
              name: z.string(),
              url: z.string(),
              defaultBranch: z.string(),
            }),
            branch: z.string(),
          }),
        },
      },
    },
    404: {
      description: "No such job, or not a readiness-gate job",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

const trialMergeTaskRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/trial-merge-task",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({
      workerId: z.string().min(1).max(200),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: {
      description:
        "What a trial-merge job has to do: merge-tree this spec's integration branch against the other live specs in the same repo, and name any conflicting files",
      content: {
        "application/json": {
          schema: z.object({
            spec: z.object({
              id: z.number().int(),
              displayId: z.string(),
              title: z.string(),
            }),
            repo: z.object({
              name: z.string(),
              url: z.string(),
              defaultBranch: z.string(),
            }),
            ours: z.object({
              specId: z.number().int(),
              branch: z.string(),
            }),
            peers: z.array(
              z.object({
                specId: z.number().int(),
                branch: z.string(),
              }),
            ),
          }),
        },
      },
    },
    404: {
      description: "No such job, or not a trial-merge job",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

const planningTaskRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/planning-task",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({
      workerId: z.string().min(1).max(200),
      attempt: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: {
      description:
        "What a planning-commit job has to do: commit the planning docs patch onto the planning repo's integration branch, or, without one, read the default branch's head (ADR 0005)",
      content: {
        "application/json": {
          schema: z.object({
            spec: z.object({
              id: z.number().int(),
              displayId: z.string(),
              title: z.string(),
            }),
            repo: z.object({
              name: z.string(),
              url: z.string(),
              defaultBranch: z.string(),
            }),
            integrationBranch: z.string(),
            patch: z.string().nullable(),
            message: z.string(),
          }),
        },
      },
    },
    404: {
      description: "No such job, or not a planning-commit job",
      content: { "application/json": { schema: ErrorReply } },
    },
    409: {
      description: "Not the lease holder at the current attempt (fencing)",
      content: { "application/json": { schema: ErrorReply } },
    },
  },
});

const leaseRoute = createRoute({
  method: "get",
  path: "/worker/jobs/{id}/lease",
  request: {
    params: z.object({ id: z.coerce.number().int().min(1).max(INT4_MAX) }),
    query: z.object({ attempt: z.coerce.number().int().min(1).max(INT4_MAX) }),
  },
  responses: {
    200: {
      description:
        "Whether the job is running under a live lease at that attempt",
      content: {
        "application/json": { schema: z.object({ held: z.boolean() }) },
      },
    },
  },
});

const FailRunFacts = z.object({
  tokenUsage: z.unknown().optional(),
  durationApiMs: z.number().int().min(0).optional(),
  cursorCliVersion: z.string().optional(),
  axis: z.enum(REVIEW_AXES).optional(),
});

const failRoute = holderRoute(
  "fail",
  {
    error: z.string(),
    run: FailRunFacts.optional(),
    extraRuns: z.array(FailRunFacts).max(8).optional(),
  },
  z.object({ ok: z.literal(true) }),
);

// An earlier passing gate of the job's repo on the same tree under the same gates.yaml blob, to reuse.
const gateResultRoute = holderRoute(
  "gate-result",
  {
    tree: z.string().min(1).max(100),
    configBlob: z.string().min(1).max(100),
  },
  z.object({
    gate: z
      .object({
        commitSha: z.string(),
        steps: z.array(
          z.object({
            name: z.string(),
            exitCode: z.number().int(),
            ms: z.number(),
          }),
        ),
        counts: z.object({
          tests: z.number().int(),
          skipped: z.number().int(),
        }),
        testCases: z
          .array(
            z.object({
              name: z.string(),
              classname: z.string(),
              status: z.enum(["passed", "failed", "skipped"]),
              flaky: z.boolean().optional(),
            }),
          )
          .optional(),
      })
      .nullable(),
  }),
);

function refusal(outcome: Exclude<HolderOutcome, { status: "ok" }>) {
  return outcome.status === "not-found"
    ? ({ body: { error: "no such job" }, status: 404 } as const)
    : ({
        body: { error: "stale attempt or lease not held" },
        status: 409,
      } as const);
}

// A worker's report on a job: what it changes is the worker's doing, and host-sync's when it is a look at the host.
function inWorkerReport<T>(
  context: AppContext,
  jobId: number,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(context.pool, async (client) => {
    const job = await client.query<{ type: string }>(
      "SELECT type FROM jobs WHERE id = $1",
      [jobId],
    );
    const source = job.rows[0]?.type === "host-sync" ? "host-sync" : "worker";
    await applyOrigin(client, { source, jobId });
    return work(client);
  });
}

// Thrown to roll back failing a job that turns out to be no stage of anything: claimJob puts it back instead.
class NoFailureCount extends Error {}

// Each job whose lease ran out is a failed try of its stage, counted as if its worker had reported it
// (recordJobFailure): queued again under a new key, or blocked at the third. Before this, a job whose worker kept
// losing it (a hung push, an API it could not reach) was handed out again and again, its agent run each time.
async function failExpiredLeases(context: AppContext): Promise<void> {
  const now = context.clock();
  for (const id of await expiredJobIds(context.pool, now)) {
    try {
      await aroundJob(context, id, () =>
        inWorkerReport(context, id, async (client) => {
          const job = await failExpiredJob(
            client,
            id,
            now,
            LEASE_EXPIRED_ERROR,
          );
          if (!job) return { status: "taken" as const }; // another claim got to it first
          const failure = await recordJobFailure(
            client,
            job,
            LEASE_EXPIRED_ERROR,
            now,
          );
          if (failure.status === "not-a-stage") throw new NoFailureCount();
          return { status: "ok" as const };
        }),
      );
    } catch (error) {
      if (!(error instanceof NoFailureCount)) throw error;
    }
  }
}

export function registerWorkerRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  // A worker says at start which code hosts it has credentials for.
  app.openapi(hostsReportRoute, async (c) => {
    const { workerId, hosts } = c.req.valid("json");
    await reportHosts(context.pool, workerId, hosts);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(workerStatusRoute, async (c) => {
    const { workerId, cleaned, freeBytes } = c.req.valid("json");
    await recordWorkerCleanup(
      context.pool,
      workerId,
      cleaned,
      context.clock(),
      freeBytes,
    );
    const sample = await context.statDisk(context.logDir);
    await refreshDiskStatus(context.pool, sample);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const { workerId, capabilities } = c.req.valid("json");
    if (
      await claimsStopped(
        context.pool,
        workerId,
        await context.freeBytes(context.logDir),
      )
    ) {
      return c.json({ job: null }, 200);
    }
    await failExpiredLeases(context);
    const job = await claimJob(context.pool, {
      workerId,
      capabilities,
      now: context.clock(),
      leaseSeconds: context.leaseSeconds,
    });
    if (!job) return c.json({ job: null }, 200);
    const specIds = await specIdsOfJob(context.pool, job.id);
    const before = await snapshotSpecs(context.pool, specIds);
    // the ticket or step starting goes with its Run, and both are the worker's doing
    await withOrigin({ source: "worker", jobId: job.id }, () =>
      inTransaction(context.pool, async (client) => {
        await markClaimed(client, job);
        await markFinalClaimed(client, job);
        await markUpdateBranchClaimed(client, job);
        await markLocateClaimed(client, job);
      }),
    );
    const run = await context.pool.query<{ id: number }>(
      "SELECT id FROM runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1",
      [job.id],
    );
    await emitTransition(context, before, {
      ...(typeof job.payload.specId === "number"
        ? { specId: job.payload.specId }
        : {}),
      ...(typeof job.payload.ticketId === "number"
        ? { ticketId: job.payload.ticketId }
        : {}),
      ...(run.rows[0] ? { runId: run.rows[0].id } : {}),
    });
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
    const outcome = await aroundJob(context, id, () =>
      inWorkerReport(context, id, async (client) => {
        const finished = await completeJob(
          client,
          { jobId: id, workerId, attempt, now: context.clock() },
          result,
        );
        if (finished.status === "ok") {
          const job = await client.query(
            "SELECT id, type, payload FROM jobs WHERE id = $1",
            [id],
          );
          const trial = readTrialMergePayload(job.rows[0]);
          if (trial) {
            await recordTrialMergeResult(client, job.rows[0], result);
            return finished;
          }
          if (readLocatePayload(job.rows[0].payload)) {
            await recordLocateResult(client, job.rows[0], result);
            return finished;
          }
          const planning = readPlanningPayload(job.rows[0]);
          // the e2e before the pull requests runs the ticket stages, but for the spec's finalization
          const recorded = planning
            ? await recordPlanningResult(client, planning, result).then(
                () => ({ status: "planning-commit" }) as const,
              )
            : readFinalE2ePayload(job.rows[0].payload)
              ? await recordFinalE2eResult(client, job.rows[0], result).then(
                  () => ({ status: "final-e2e" }) as const,
                )
              : await recordStageResult(client, job.rows[0], result);
          // not a ticket stage: it may be a step of a finalization, or a job for the code host
          if (recorded.status === "no-ticket") {
            const updated = await recordUpdateBranchResult(
              client,
              job.rows[0],
              result,
              context.clock(),
            );
            if (updated.status === "not-update-branch") {
              const final = await recordFinalResult(
                client,
                job.rows[0],
                result,
              );
              if (final.status === "not-final") {
                const openPr = readOpenPrPayload(job.rows[0]);
                const sync = readHostSyncPayload(job.rows[0]);
                const cleanup = readSpecCleanupPayload(job.rows[0]);
                const ready = readPrReadyPayload(job.rows[0]);
                const access = readRepoAccessPayload(job.rows[0]);
                const indexLinks = readIndexPrLinksPayload(job.rows[0]);
                if (access)
                  await recordRepoAccess(
                    client,
                    access,
                    (result ?? {}) as Record<string, unknown>,
                    context.clock(),
                  );
                else if (openPr)
                  await recordOpenPr(client, openPr, result, context.clock());
                else if (sync)
                  await recordHostSync(client, sync, result, context.clock());
                else if (cleanup)
                  await recordSpecCleanup(client, cleanup, result);
                else if (ready) await recordPrReady(client, ready, result);
                else if (indexLinks)
                  await recordIndexPrLinks(client, indexLinks, result);
              }
            }
          }
        }
        return finished;
      }),
    );
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

  app.openapi(hostTaskRoute, async (c) => {
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
    const job = await context.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT type, payload FROM jobs WHERE id = $1", [id]);
    const row = job.rows[0];
    const access = row && readRepoAccessPayload(row);
    if (access) {
      const task = await repoAccessTask(context.pool, access);
      return task
        ? c.json(task, 200)
        : c.json({ error: "the repo is gone" }, 404);
    }
    const payload =
      row &&
      (readOpenPrPayload(row) ??
        readHostSyncPayload(row) ??
        readPrReadyPayload(row) ??
        readSpecCleanupPayload(row) ??
        readPatchPrBodyPayload(row) ??
        readIndexPrLinksPayload(row));
    const task =
      row && payload && (await buildHostTask(context.pool, row, payload));
    if (!task)
      return c.json({ error: "this job is not for the code host" }, 404);
    return c.json(task, 200);
  });

  app.openapi(readinessTaskRoute, async (c) => {
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
    const job = await context.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT type, payload FROM jobs WHERE id = $1", [id]);
    const payload = job.rows[0] && readReadinessGatePayload(job.rows[0]);
    const task = payload && (await readinessGateTask(context.pool, payload));
    if (!task)
      return c.json({ error: "this job is not a readiness gate" }, 404);
    return c.json(task, 200);
  });

  app.openapi(trialMergeTaskRoute, async (c) => {
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
    const job = await context.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT type, payload FROM jobs WHERE id = $1", [id]);
    const payload = job.rows[0] && readTrialMergePayload(job.rows[0]);
    const task = payload && (await buildTrialMergeTask(context.pool, payload));
    if (!task) return c.json({ error: "this job is not a trial-merge" }, 404);
    return c.json(task, 200);
  });

  app.openapi(planningTaskRoute, async (c) => {
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
    const job = await context.pool.query<{
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT type, payload FROM jobs WHERE id = $1", [id]);
    const payload = job.rows[0] && readPlanningPayload(job.rows[0]);
    const task =
      payload && (await buildPlanningTask(context.pool, payload.specId));
    if (!task)
      return c.json({ error: "this job is not a planning commit" }, 404);
    return c.json(task, 200);
  });

  app.openapi(leaseRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { attempt } = c.req.valid("query");
    const held = await isLeaseLive(context.pool, {
      jobId: id,
      attempt,
      now: context.clock(),
    });
    return c.json({ held }, 200);
  });

  app.openapi(gateResultRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, tree, configBlob } = c.req.valid("json");
    const held = await checkHolder(context.pool, {
      jobId: id,
      workerId,
      attempt,
      now: context.clock(),
    });
    if (held.status !== "ok") {
      const { body, status } = refusal(held);
      return c.json(body, status);
    }
    const gate = await findPassingGate(context.pool, id, { tree, configBlob });
    return c.json({ gate }, 200);
  });

  app.openapi(failRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workerId, attempt, error, run, extraRuns } = c.req.valid("json");
    // the job failing and what that means for its ticket happen together or not at all
    const outcome = await aroundJob(context, id, () =>
      inWorkerReport(context, id, async (client) => {
        const failed = await failJob(
          client,
          { jobId: id, workerId, attempt, now: context.clock() },
          error,
        );
        if (failed.status === "ok") {
          const job = await client.query(
            "SELECT id, type, payload FROM jobs WHERE id = $1",
            [id],
          );
          // the agents' provider refuses work: not this stage's failure, the job waits until a person resumes
          const paused = await pauseForProvider(
            client,
            job.rows[0],
            error,
            context.clock(),
          );
          if (paused !== false) {
            return failed;
          }
          const failure = await recordJobFailure(
            client,
            job.rows[0],
            error,
            context.clock(),
            run,
            extraRuns,
          );
          const sync = readHostSyncPayload(job.rows[0]);
          const access = readRepoAccessPayload(job.rows[0]);
          if (failure.status === "not-a-stage" && sync)
            await hostSyncFailed(
              client,
              sync.projectId,
              context.clock(),
              error,
            );
          if (failure.status === "not-a-stage" && access)
            await repoAccessFailed(client, access, error, context.clock());
        }
        return failed;
      }),
    );
    if (outcome.status !== "ok") {
      const { body, status } = refusal(outcome);
      return c.json(body, status);
    }
    return c.json({ ok: true as const }, 200);
  });
}
