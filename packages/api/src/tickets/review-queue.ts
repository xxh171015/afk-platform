import {
  autoMergeLine,
  formatDisplayId,
  type HostKind,
  type SpecState,
} from "@afk/shared";
import type pg from "pg";
import { autoMergeViewOf } from "../host/auto-merge.ts";
import { enqueueReviewRevision } from "../host/review-revision.ts";
import { inTransaction } from "../scheduling/scheduler.ts";

// Cross-project Review queue (GLOSSARY Review queue; docs/specs/in-platform-review.md §6).
// Four groups, risk tags rather than a score. GET also enqueues a Review revision when a
// queued spec's open PR has no ready one yet.

export type ReviewQueueCi = "none" | "pending" | "success" | "failure";

export interface ReviewQueueRow {
  spec: {
    id: number;
    displayId: string;
    title: string;
    type: string;
    state: SpecState;
    project: string;
  };
  repos: string[];
  hostKind: HostKind;
  pullRequestCount: number;
  waitingSince: string;
  additions: number;
  deletions: number;
  viewedCount: number | null;
  filesCount: number | null;
  ci: ReviewQueueCi;
  conflictsWithDefault: boolean;
  autoMergeLine: string | null;
  riskTags: string[];
}

export interface ReviewQueue {
  waitingForYou: ReviewQueueRow[];
  inProgress: ReviewQueueRow[];
  inRework: ReviewQueueRow[];
  readyToMerge: ReviewQueueRow[];
}

const EMPTY: ReviewQueue = {
  waitingForYou: [],
  inProgress: [],
  inRework: [],
  readyToMerge: [],
};

interface SpecRow {
  id: number;
  title: string;
  type: string;
  state: SpecState;
  created_at: Date;
  order_broken: unknown;
  project: string;
}

interface PullRow {
  id: number;
  spec_id: number;
  repo: string;
  host_kind: string;
  state: string;
  ci: ReviewQueueCi;
  conflicts: boolean;
  revision_state: string | null;
  files_count: number;
  additions: number;
  deletions: number;
  viewed_count: number;
  unviewed_since: number;
}

interface PackContent {
  needsDecision?: { kind?: string }[];
  orderBroken?: unknown[];
  repos?: {
    tickets?: { criteria?: { status?: string }[] }[];
    protectedPathApprovals?: unknown[];
  }[];
  integration?: { tickets?: { criteria?: { status?: string }[] }[] };
}

type GroupKey = keyof ReviewQueue;

interface BuiltRow extends ReviewQueueRow {
  group: GroupKey;
}

function iso(value: Date | string | null | undefined, fallback: Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

function nonemptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function ciOf(pulls: PullRow[]): ReviewQueueCi {
  if (pulls.some((pull) => pull.ci === "failure")) return "failure";
  if (pulls.some((pull) => pull.ci === "pending")) return "pending";
  if (pulls.some((pull) => pull.ci === "success")) return "success";
  return "none";
}

function packFlags(pack: PackContent | null): {
  needsHuman: boolean;
  deferred: boolean;
  hostCheck: boolean;
  unverified: boolean;
  packProtected: boolean;
  packOrderBroken: boolean;
} {
  const needs = pack?.needsDecision ?? [];
  const tickets = [
    ...(pack?.repos ?? []).flatMap((repo) => repo.tickets ?? []),
    ...(pack?.integration?.tickets ?? []),
  ];
  return {
    needsHuman: needs.some((item) => item.kind === "needs-human"),
    deferred: needs.some((item) => item.kind === "deferred"),
    hostCheck: needs.some((item) => item.kind === "host-check"),
    unverified: tickets.some((ticket) =>
      (ticket.criteria ?? []).some(
        (criterion) => criterion.status === "unverified",
      ),
    ),
    packProtected: (pack?.repos ?? []).some((repo) =>
      nonemptyArray(repo.protectedPathApprovals),
    ),
    packOrderBroken: nonemptyArray(pack?.orderBroken),
  };
}

function riskTagsOf(input: {
  needsHuman: boolean;
  declinedComments: boolean;
  ciFailure: boolean;
  conflicts: boolean;
  orderBroken: boolean;
  unverified: boolean;
  deferred: boolean;
  hostCheck: boolean;
  protectedPaths: boolean;
  removedTests: boolean;
  multiRepo: boolean;
  contractEdge: boolean;
}): string[] {
  const tags: string[] = [];
  if (input.needsHuman) tags.push("待人定");
  if (input.declinedComments) tags.push("人审意见未处理");
  if (input.ciFailure) tags.push("CI 失败");
  if (input.conflicts) tags.push("与默认分支冲突");
  if (input.orderBroken) tags.push("合并顺序被打破");
  if (input.unverified) tags.push("未验证验收标准");
  if (input.deferred) tags.push("没做掉的 deferred");
  if (input.hostCheck) tags.push("host-check");
  if (input.protectedPaths) tags.push("保护路径改动");
  if (input.removedTests) tags.push("删除测试");
  if (input.multiRepo) tags.push("多仓库");
  if (input.contractEdge) tags.push("有契约边");
  return tags;
}

function riskFlags(tags: string[]): boolean[] {
  return [
    tags.some((tag) => tag === "待人定" || tag === "人审意见未处理"),
    tags.some(
      (tag) =>
        tag === "CI 失败" ||
        tag === "与默认分支冲突" ||
        tag === "合并顺序被打破",
    ),
    tags.some(
      (tag) =>
        tag === "未验证验收标准" ||
        tag === "没做掉的 deferred" ||
        tag === "host-check",
    ),
    tags.some((tag) => tag === "保护路径改动" || tag === "删除测试"),
    tags.some((tag) => tag === "多仓库" || tag === "有契约边"),
  ];
}

function compareRows(a: ReviewQueueRow, b: ReviewQueueRow): number {
  const left = riskFlags(a.riskTags);
  const right = riskFlags(b.riskTags);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] ? -1 : 1;
  }
  const linesA = a.additions + a.deletions;
  const linesB = b.additions + b.deletions;
  if (linesA !== linesB) return linesB - linesA;
  const waited = a.waitingSince.localeCompare(b.waitingSince);
  if (waited !== 0) return waited;
  return a.spec.id - b.spec.id;
}

export async function reviewQueue(
  pool: pg.Pool,
  now: Date,
  projectId?: number,
): Promise<ReviewQueue> {
  const specs = await pool.query<SpecRow>(
    `SELECT s.id, s.title, s.type, s.state, s.created_at, s.order_broken, p.name AS project
     FROM specs s
     JOIN projects p ON p.id = s.project_id
     WHERE (
       s.state IN ('awaiting-review', 'partially-merged', 'reworking')
       OR (
         s.state = 'finalizing'
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'awaiting-review'
         )
       )
     )
     AND ($1::int IS NULL OR s.project_id = $1)
     ORDER BY s.id`,
    [projectId ?? null],
  );
  if (specs.rows.length === 0) return { ...EMPTY };

  const specIds = specs.rows.map((row) => row.id);
  const pulls = await pool.query<PullRow>(
    `SELECT p.id, p.spec_id, r.name AS repo, r.host_kind, p.state, p.ci,
            p.conflicts_with_default AS conflicts,
            rev.state AS revision_state,
            COALESCE(rev.files_count, 0) AS files_count,
            COALESCE(rev.additions, 0) AS additions,
            COALESCE(rev.deletions, 0) AS deletions,
            COALESCE((
              SELECT count(*)::int FROM review_files f
              JOIN review_file_views v
                ON v.pull_request_id = p.id AND v.path = f.path AND v.new_blob = f.new_blob
              WHERE f.revision_id = rev.id
            ), 0) AS viewed_count,
            COALESCE((
              SELECT count(*)::int FROM review_files f
              LEFT JOIN review_file_views v
                ON v.pull_request_id = p.id AND v.path = f.path AND v.new_blob = f.new_blob
              WHERE f.revision_id = rev.id
                AND f.since_patch IS NOT NULL AND f.since_patch <> ''
                AND v.path IS NULL
            ), 0) AS unviewed_since
     FROM pull_requests p
     JOIN repos r ON r.id = p.repo_id
     LEFT JOIN review_revisions rev
       ON rev.pull_request_id = p.id AND rev.head_sha = p.head_sha
     WHERE p.spec_id = ANY($1)
     ORDER BY p.id`,
    [specIds],
  );
  const packs = await pool.query<{ spec_id: number; content: PackContent }>(
    "SELECT spec_id, content FROM acceptance_packs WHERE spec_id = ANY($1)",
    [specIds],
  );
  const ticketFlags = await pool.query<{
    spec_id: number;
    protected_paths: boolean;
    removed_tests: boolean;
  }>(
    `SELECT spec_id,
            bool_or(cardinality(allowed_protected_paths) > 0) AS protected_paths,
            bool_or(jsonb_array_length(allowed_removed_tests) > 0) AS removed_tests
     FROM tickets
     WHERE spec_id = ANY($1)
     GROUP BY spec_id`,
    [specIds],
  );
  const contracts = await pool.query<{ spec_id: number }>(
    `SELECT DISTINCT t.spec_id
     FROM edges e
     JOIN tickets t ON t.id IN (e.from_ticket_id, e.to_ticket_id)
     WHERE e.kind = 'contract' AND t.spec_id = ANY($1)`,
    [specIds],
  );
  const times = await pool.query<{
    spec_id: number;
    last_awaiting: Date | null;
    last_rework: Date | null;
  }>(
    `SELECT spec_id,
            max(at) FILTER (WHERE to_state = 'awaiting-review') AS last_awaiting,
            max(at) FILTER (WHERE to_state IN ('reworking', 'finalizing')) AS last_rework
     FROM events
     WHERE spec_id = ANY($1) AND type = 'spec'
     GROUP BY spec_id`,
    [specIds],
  );
  const comments = await pool.query<{
    spec_id: number;
    drafts: number;
    declined: boolean;
  }>(
    `SELECT spec_id,
            count(*) FILTER (WHERE state = 'draft')::int AS drafts,
            bool_or(state = 'declined') AS declined
     FROM review_comments
     WHERE spec_id = ANY($1)
     GROUP BY spec_id`,
    [specIds],
  );

  const pullsBySpec = new Map<number, PullRow[]>();
  for (const pull of pulls.rows) {
    const list = pullsBySpec.get(pull.spec_id) ?? [];
    list.push(pull);
    pullsBySpec.set(pull.spec_id, list);
  }
  const packBySpec = new Map(
    packs.rows.map((row) => [row.spec_id, row.content]),
  );
  const ticketBySpec = new Map(
    ticketFlags.rows.map((row) => [row.spec_id, row]),
  );
  const contractSpecs = new Set(contracts.rows.map((row) => row.spec_id));
  const timeBySpec = new Map(times.rows.map((row) => [row.spec_id, row]));
  const commentsBySpec = new Map(
    comments.rows.map((row) => [row.spec_id, row]),
  );

  const built: BuiltRow[] = [];
  const enqueuePullIds = new Set<number>();
  for (const spec of specs.rows) {
    const specPulls = pullsBySpec.get(spec.id) ?? [];
    const ready =
      specPulls.length > 0 &&
      specPulls.every((pull) => pull.revision_state === "ready");
    const filesCount = specPulls.reduce(
      (sum, pull) => sum + pull.files_count,
      0,
    );
    const viewedCount = specPulls.reduce(
      (sum, pull) => sum + pull.viewed_count,
      0,
    );
    const hasUnviewedSince = specPulls.some((pull) => pull.unviewed_since > 0);
    const computed = ready
      ? { viewedCount, filesCount }
      : { viewedCount: null, filesCount: null };
    const allViewed = ready && viewedCount === filesCount && !hasUnviewedSince;
    const commentFlags = commentsBySpec.get(spec.id);
    const hasDrafts = (commentFlags?.drafts ?? 0) > 0;
    const readyToMergeViews = allViewed && !hasDrafts;
    const inProgressReview =
      spec.state === "awaiting-review" &&
      (hasDrafts || viewedCount > 0 || hasUnviewedSince) &&
      !readyToMergeViews;
    const hadAwaiting = timeBySpec.get(spec.id)?.last_awaiting != null;
    const inRework =
      spec.state === "reworking" ||
      (spec.state === "finalizing" && hadAwaiting);

    let group: GroupKey;
    if (inRework) group = "inRework";
    else if (spec.state === "partially-merged" || readyToMergeViews)
      group = "readyToMerge";
    else if (inProgressReview) group = "inProgress";
    else group = "waitingForYou";

    const pack = packFlags(packBySpec.get(spec.id) ?? null);
    const tickets = ticketBySpec.get(spec.id);
    const repos = [...new Set(specPulls.map((pull) => pull.repo))];
    const hostKind: HostKind =
      specPulls[0]?.host_kind === "gitlab" ? "gitlab" : "github";
    const ci = ciOf(specPulls);
    const conflicts = specPulls.some((pull) => pull.conflicts);
    const time = timeBySpec.get(spec.id);
    const waitingSince = iso(
      inRework
        ? (time?.last_rework ?? spec.created_at)
        : (time?.last_awaiting ?? spec.created_at),
      spec.created_at,
    );
    const autoMerge = await autoMergeViewOf(pool, spec.id, now);
    built.push({
      spec: {
        id: spec.id,
        displayId: formatDisplayId("spec", spec.id),
        title: spec.title,
        type: spec.type,
        state: spec.state,
        project: spec.project,
      },
      repos,
      hostKind,
      pullRequestCount: specPulls.length,
      waitingSince,
      additions: specPulls.reduce((sum, pull) => sum + pull.additions, 0),
      deletions: specPulls.reduce((sum, pull) => sum + pull.deletions, 0),
      viewedCount: computed.viewedCount,
      filesCount: computed.filesCount,
      ci,
      conflictsWithDefault: conflicts,
      autoMergeLine: autoMergeLine(autoMerge, spec.state),
      riskTags: riskTagsOf({
        needsHuman: pack.needsHuman,
        declinedComments: commentFlags?.declined === true,
        ciFailure: ci === "failure",
        conflicts,
        orderBroken: nonemptyArray(spec.order_broken) || pack.packOrderBroken,
        unverified: pack.unverified,
        deferred: pack.deferred,
        hostCheck: pack.hostCheck,
        protectedPaths: pack.packProtected || tickets?.protected_paths === true,
        removedTests: tickets?.removed_tests === true,
        multiRepo: repos.length > 1,
        contractEdge: contractSpecs.has(spec.id),
      }),
      group,
    });
    for (const pull of specPulls) {
      if (pull.state === "open" && pull.revision_state !== "ready") {
        enqueuePullIds.add(pull.id);
      }
    }
  }

  if (enqueuePullIds.size > 0) {
    await inTransaction(pool, async (client) => {
      for (const pullId of enqueuePullIds) {
        await enqueueReviewRevision(client, pullId);
      }
    });
  }

  const queue: ReviewQueue = {
    waitingForYou: [],
    inProgress: [],
    inRework: [],
    readyToMerge: [],
  };
  for (const row of built) {
    const { group, ...publicRow } = row;
    queue[group].push(publicRow);
  }
  for (const key of Object.keys(queue) as GroupKey[]) {
    queue[key].sort(compareRows);
  }
  return queue;
}
