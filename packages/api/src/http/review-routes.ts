import {
  HOST_KINDS,
  MERGE_POLICIES,
  REVIEW_AXES,
  REVIEW_FILE_STATUSES,
  REVIEW_PATCH_OMITTED_REASONS,
  REVIEW_REVISION_STATES,
  SPEC_STATES,
} from "@afk/shared";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AcceptancePack } from "../acceptance/pack.ts";
import type { AppContext } from "../app.ts";
import {
  deleteReviewFileViewed,
  putReviewFileViewed,
  reviewBlobSliceOf,
  reviewFilePatchOf,
  reviewRevisionOf,
  specReviewOf,
} from "../host/review.ts";
import { inTransaction } from "../scheduling/scheduler.ts";
import { reviewQueue } from "../tickets/review-queue.ts";
import { ErrorReply, INT4_MAX } from "./schemas.ts";

const Id = z.number().int();
const PathId = z.coerce.number().int().min(1).max(INT4_MAX);
const GitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "a git SHA is 40 lowercase hex characters");
const json = <T extends z.ZodType>(schema: T) => ({
  "application/json": { schema },
});
const reply = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const AutoMerge = z.object({
  policy: z.enum(MERGE_POLICIES),
  willMerge: z.boolean(),
  mergeAt: z.string().nullable(),
  reason: z.string().nullable(),
  event: z
    .object({
      type: z.enum(["auto-merged", "auto-merge-failed"]),
      reason: z.string().nullable(),
    })
    .nullable(),
});

const Attribution = z.union([
  z.object({ ticket: z.string() }),
  z.object({ run: z.string(), stage: z.string().optional() }),
  z.object({ kind: z.enum(["setup", "planning", "unknown"]) }),
]);

const Hunk = z.object({
  newStart: z.number().int(),
  newLines: z.number().int(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  owners: z.array(z.record(z.string(), z.unknown())),
});

const RevisionSummary = z.object({
  id: Id.nullable(),
  state: z.enum(REVIEW_REVISION_STATES),
  complete: z.boolean(),
  filesCount: Id,
  additions: Id,
  deletions: Id,
  viewedCount: Id,
  commentCount: Id,
  error: z.string().nullable(),
});

const SpecReview = z.object({
  spec: z.object({
    id: Id,
    displayId: z.string(),
    title: z.string(),
    type: z.string(),
    state: z.enum(SPEC_STATES),
  }),
  userStories: z.array(z.object({ number: Id, text: z.string() })),
  pullRequests: z.array(
    z.object({
      id: Id,
      repo: z.string(),
      number: Id,
      url: z.string(),
      state: z.enum(["open", "closed", "merged"]),
      draft: z.boolean(),
      ci: z.enum(["none", "pending", "success", "failure"]),
      review: z.enum(["none", "approved", "changes-requested"]),
      headSha: z.string(),
      conflictsWithDefault: z.boolean(),
      humanComments: Id.nullable(),
      revision: RevisionSummary,
    }),
  ),
  acceptancePack: AcceptancePack.nullable(),
  autoMerge: AutoMerge,
  tickets: z.array(
    z.object({
      id: Id,
      displayId: z.string(),
      title: z.string(),
      stories: z.array(Id),
      criteria: z.array(
        z.object({
          text: z.string(),
          tests: z.array(z.string()),
          status: z.enum(["verified", "unverified"]),
          reason: z.string().nullable(),
        }),
      ),
    }),
  ),
  findings: z.array(
    z.object({
      ticket: z.string().nullable(),
      run: z.string(),
      stage: z.string(),
      kind: z.string(),
      body: z.string(),
      resolution: z.string(),
      axis: z.enum(REVIEW_AXES).nullable(),
    }),
  ),
});

const ReviewFile = z.object({
  id: Id,
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(REVIEW_FILE_STATUSES),
  oldBlob: z.string(),
  newBlob: z.string(),
  additions: Id,
  deletions: Id,
  binary: z.boolean(),
  generated: z.boolean(),
  test: z.boolean(),
  lockfile: z.boolean(),
  patchOmitted: z.enum(REVIEW_PATCH_OMITTED_REASONS).nullable(),
  attributions: z.array(Attribution),
  hunks: z.array(Hunk).nullable(),
  viewed: z.boolean(),
});

const ReviewRevision = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    id: Id.nullable(),
    headSha: GitSha,
  }),
  z.object({
    state: z.literal("failed"),
    id: Id,
    headSha: GitSha,
    error: z.string().nullable(),
  }),
  z.object({
    state: z.literal("ready"),
    id: Id,
    headSha: GitSha,
    baseSha: z.string().nullable(),
    mergeBaseSha: z.string().nullable(),
    previousHeadSha: z.string().nullable(),
    complete: z.boolean(),
    omittedReason: z.string().nullable(),
    filesCount: Id,
    additions: Id,
    deletions: Id,
    files: z.array(ReviewFile),
  }),
]);

const FilePatch = z.object({
  id: Id,
  path: z.string(),
  view: z.enum(["all", "since"]),
  patch: z.string().nullable(),
  patchOmitted: z.enum(REVIEW_PATCH_OMITTED_REASONS).nullable(),
});

const BlobSlice = z.object({
  sha: GitSha,
  from: Id,
  to: Id,
  stored: z.boolean(),
  lines: z.array(z.string()),
});

const ViewedBody = z.object({ newBlob: GitSha });
const ViewedReply = z.object({ viewed: z.boolean() });

const ReviewQueueRow = z.object({
  spec: z.object({
    id: Id,
    displayId: z.string(),
    title: z.string(),
    type: z.string(),
    state: z.enum(SPEC_STATES),
    project: z.string(),
  }),
  repos: z.array(z.string()),
  hostKind: z.enum(HOST_KINDS),
  pullRequestCount: Id,
  waitingSince: z.string(),
  additions: Id,
  deletions: Id,
  viewedCount: Id.nullable(),
  filesCount: Id.nullable(),
  ci: z.enum(["none", "pending", "success", "failure"]),
  conflictsWithDefault: z.boolean(),
  autoMergeLine: z.string().nullable(),
  riskTags: z.array(z.string()),
});

const ReviewQueue = z.object({
  waitingForYou: z.array(ReviewQueueRow),
  inProgress: z.array(ReviewQueueRow),
  inRework: z.array(ReviewQueueRow),
  readyToMerge: z.array(ReviewQueueRow),
});

const queueRoute = createRoute({
  method: "get",
  path: "/review-queue",
  request: {
    query: z.object({
      project: z.coerce.number().int().min(1).max(INT4_MAX).optional(),
    }),
  },
  responses: {
    200: reply(
      "Specs waiting for review, grouped and ordered by risk tags",
      ReviewQueue,
    ),
  },
});

const specReviewRoute = createRoute({
  method: "get",
  path: "/specs/{id}/review",
  request: { params: z.object({ id: PathId }) },
  responses: {
    200: reply(
      "This spec's pull requests, Review revisions, merge checklist, tickets and Findings",
      SpecReview,
    ),
    404: reply("No such spec", ErrorReply),
  },
});

const revisionRoute = createRoute({
  method: "get",
  path: "/pull-requests/{id}/review-revision",
  request: {
    params: z.object({ id: PathId }),
    query: z.object({ head: GitSha }),
  },
  responses: {
    200: reply(
      "The Review revision for this pull request head; pending if it is still being computed",
      ReviewRevision,
    ),
    404: reply("No such pull request or Review revision", ErrorReply),
  },
});

const fileRoute = createRoute({
  method: "get",
  path: "/review-files/{id}",
  request: {
    params: z.object({ id: PathId }),
    query: z.object({
      view: z.enum(["all", "since"]).optional().default("all"),
    }),
  },
  responses: {
    200: reply(
      "The file's patch, or the patch since it was last reviewed",
      FilePatch,
    ),
    404: reply("No such review file", ErrorReply),
  },
});

const blobRoute = createRoute({
  method: "get",
  path: "/review-blobs/{sha}",
  request: {
    params: z.object({ sha: GitSha }),
    query: z.object({
      from: z.coerce.number().int().min(1).max(INT4_MAX),
      to: z.coerce.number().int().min(1).max(INT4_MAX),
    }),
  },
  responses: {
    200: reply(
      "A line slice of a blob that belongs to a Review revision",
      BlobSlice,
    ),
    400: reply("The line range is not valid", ErrorReply),
    404: reply("No such Review blob", ErrorReply),
  },
});

const viewedParams = z.object({
  id: PathId,
  path: z.string().min(1).max(500),
});

const putViewedRoute = createRoute({
  method: "put",
  path: "/pull-requests/{id}/viewed-files/{path}",
  request: {
    params: viewedParams,
    body: { content: json(ViewedBody) },
  },
  responses: {
    200: reply("The file is marked viewed at this blob", ViewedReply),
    404: reply("No such pull request", ErrorReply),
  },
});

const deleteViewedRoute = createRoute({
  method: "delete",
  path: "/pull-requests/{id}/viewed-files/{path}",
  request: {
    params: viewedParams,
    body: { content: json(ViewedBody) },
  },
  responses: {
    200: reply("The viewed mark is removed", ViewedReply),
    404: reply("No such pull request", ErrorReply),
  },
});

function filePathOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerReviewRoutes(
  app: OpenAPIHono,
  context: AppContext,
): void {
  const { pool } = context;

  app.openapi(queueRoute, async (c) => {
    const queue = await reviewQueue(
      pool,
      context.clock(),
      c.req.valid("query").project,
    );
    return c.json(queue, 200);
  });

  app.openapi(specReviewRoute, async (c) => {
    const view = await specReviewOf(
      pool,
      c.req.valid("param").id,
      context.clock(),
    );
    return view ? c.json(view, 200) : c.json({ error: "no such spec" }, 404);
  });

  app.openapi(revisionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { head } = c.req.valid("query");
    const view = await inTransaction(pool, (client) =>
      reviewRevisionOf(client, id, head),
    );
    if ("status" in view) return c.json({ error: "no such pull request" }, 404);
    return c.json(view, 200);
  });

  app.openapi(fileRoute, async (c) => {
    const view = await reviewFilePatchOf(
      pool,
      c.req.valid("param").id,
      c.req.valid("query").view,
    );
    return view
      ? c.json(view, 200)
      : c.json({ error: "no such review file" }, 404);
  });

  app.openapi(blobRoute, async (c) => {
    const { sha } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    if (to < from) return c.json({ error: "to must be at least from" }, 400);
    const view = await reviewBlobSliceOf(pool, sha, from, to);
    return view
      ? c.json(view, 200)
      : c.json({ error: "no such review blob" }, 404);
  });

  app.openapi(putViewedRoute, async (c) => {
    const { id, path } = c.req.valid("param");
    const { newBlob } = c.req.valid("json");
    const result = await inTransaction(pool, (client) =>
      putReviewFileViewed(client, {
        pullId: id,
        path: filePathOf(path),
        newBlob,
        viewedAt: context.clock(),
      }),
    );
    return result === "ok"
      ? c.json({ viewed: true }, 200)
      : c.json({ error: "no such pull request" }, 404);
  });

  app.openapi(deleteViewedRoute, async (c) => {
    const { id, path } = c.req.valid("param");
    const { newBlob } = c.req.valid("json");
    const result = await inTransaction(pool, (client) =>
      deleteReviewFileViewed(client, {
        pullId: id,
        path: filePathOf(path),
        newBlob,
      }),
    );
    return result === "ok"
      ? c.json({ viewed: false }, 200)
      : c.json({ error: "no such pull request" }, 404);
  });
}
