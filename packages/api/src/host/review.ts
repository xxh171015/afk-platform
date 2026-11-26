import {
  formatDisplayId,
  type ReviewAttribution,
  type ReviewFileStatus,
  type ReviewHunk,
  type ReviewPatchOmittedReason,
  type ReviewRevisionState,
} from "@afk/shared";
import { userStoriesOf } from "@afk/shared/user-stories";
import type pg from "pg";
import { readAcceptancePack } from "../acceptance/pack.ts";
import { type AutoMergeView, autoMergeViewOf } from "./auto-merge.ts";
import {
  enqueueReviewRevision,
  markReviewFileViewed,
  unmarkReviewFileViewed,
} from "./review-revision.ts";

export type { AutoMergeView };

export interface SpecReviewPull {
  id: number;
  repo: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  ci: "none" | "pending" | "success" | "failure";
  review: "none" | "approved" | "changes-requested";
  headSha: string;
  conflictsWithDefault: boolean;
  humanComments: number | null;
  revision: {
    id: number | null;
    state: ReviewRevisionState;
    complete: boolean;
    filesCount: number;
    additions: number;
    deletions: number;
    viewedCount: number;
    commentCount: number;
    error: string | null;
  };
}

export interface SpecReviewTicket {
  id: number;
  displayId: string;
  title: string;
  stories: number[];
  criteria: {
    text: string;
    tests: string[];
    status: "verified" | "unverified";
    reason: string | null;
  }[];
}

export interface SpecReviewFinding {
  ticket: string | null;
  run: string;
  stage: string;
  kind: string;
  body: string;
  resolution: string;
  axis: string | null;
}

export interface SpecReviewView {
  spec: {
    id: number;
    displayId: string;
    title: string;
    type: string;
    state: string;
  };
  userStories: { number: number; text: string }[];
  pullRequests: SpecReviewPull[];
  acceptancePack: Awaited<ReturnType<typeof readAcceptancePack>>;
  autoMerge: AutoMergeView;
  tickets: SpecReviewTicket[];
  findings: SpecReviewFinding[];
}

export interface ReviewRevisionFileView {
  id: number;
  path: string;
  oldPath: string | null;
  status: ReviewFileStatus;
  oldBlob: string;
  newBlob: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  test: boolean;
  lockfile: boolean;
  patchOmitted: ReviewPatchOmittedReason | null;
  attributions: ReviewAttribution[];
  hunks: ReviewHunk[] | null;
  viewed: boolean;
}

export type ReviewRevisionView =
  | {
      state: "pending";
      id: number | null;
      headSha: string;
    }
  | {
      state: "ready";
      id: number;
      headSha: string;
      baseSha: string | null;
      mergeBaseSha: string | null;
      previousHeadSha: string | null;
      complete: boolean;
      omittedReason: string | null;
      filesCount: number;
      additions: number;
      deletions: number;
      files: ReviewRevisionFileView[];
    }
  | {
      state: "failed";
      id: number;
      headSha: string;
      error: string | null;
    };

export interface ReviewFilePatchView {
  id: number;
  path: string;
  view: "all" | "since";
  patch: string | null;
  patchOmitted: ReviewPatchOmittedReason | null;
}

export interface ReviewBlobSliceView {
  sha: string;
  from: number;
  to: number;
  stored: boolean;
  lines: string[];
}

const GIT_SHA = /^[0-9a-f]{40}$/;

export function blobLines(content: string, from: number, to: number): string[] {
  const raw = content.split("\n");
  if (raw.at(-1) === "") raw.pop();
  return raw.slice(from - 1, to);
}

export async function specReviewOf(
  pool: pg.Pool,
  specId: number,
  now: Date,
): Promise<SpecReviewView | undefined> {
  const spec = await pool.query<{
    id: number;
    title: string;
    type: string;
    state: string;
    body: string;
  }>("SELECT id, title, type, state, body FROM specs WHERE id = $1", [specId]);
  const row = spec.rows[0];
  if (!row) return undefined;
  const pack = await readAcceptancePack(pool, specId);
  const autoMerge = await autoMergeViewOf(pool, specId, now);
  const pulls = await pool.query<{
    id: number;
    repo: string;
    number: number;
    url: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    ci: "none" | "pending" | "success" | "failure";
    review: "none" | "approved" | "changes-requested";
    head_sha: string;
    conflicts_with_default: boolean;
    human_comments: number | null;
    revision_id: number | null;
    revision_state: string | null;
    complete: boolean | null;
    files_count: number | null;
    additions: number | null;
    deletions: number | null;
    error: string | null;
    viewed_count: string | null;
  }>(
    `SELECT p.id, r.name AS repo, p.number, p.url, p.state, p.draft, p.ci, p.review,
            p.head_sha, p.conflicts_with_default, p.human_comments,
            rev.id AS revision_id, rev.state AS revision_state, rev.complete,
            rev.files_count, rev.additions, rev.deletions, rev.error,
            (
              SELECT count(*)::text FROM review_files f
              JOIN review_file_views v
                ON v.pull_request_id = p.id AND v.path = f.path AND v.new_blob = f.new_blob
              WHERE f.revision_id = rev.id
            ) AS viewed_count
     FROM pull_requests p
     JOIN repos r ON r.id = p.repo_id
     LEFT JOIN review_revisions rev
       ON rev.pull_request_id = p.id AND rev.head_sha = p.head_sha
     WHERE p.spec_id = $1
     ORDER BY p.id`,
    [specId],
  );
  const criteriaByTicket = new Map<string, SpecReviewTicket["criteria"]>();
  const findings: SpecReviewFinding[] = [];
  for (const repo of pack?.repos ?? []) {
    for (const ticket of repo.tickets) {
      criteriaByTicket.set(ticket.displayId, ticket.criteria);
    }
    for (const finding of repo.findings) {
      findings.push({
        ticket: finding.ticket,
        run: finding.run,
        stage: finding.stage,
        kind: finding.kind,
        body: finding.body,
        resolution: finding.resolution,
        axis: finding.axis,
      });
    }
  }
  const tickets = await pool.query<{
    id: number;
    title: string;
    stories: number[];
  }>("SELECT id, title, stories FROM tickets WHERE spec_id = $1 ORDER BY id", [
    specId,
  ]);
  return {
    spec: {
      id: row.id,
      displayId: formatDisplayId("spec", row.id),
      title: row.title,
      type: row.type,
      state: row.state,
    },
    userStories: userStoriesOf(row.body),
    pullRequests: pulls.rows.map((pull) => ({
      id: pull.id,
      repo: pull.repo,
      number: pull.number,
      url: pull.url,
      state: pull.state,
      draft: pull.draft,
      ci: pull.ci,
      review: pull.review,
      headSha: pull.head_sha,
      conflictsWithDefault: pull.conflicts_with_default,
      humanComments: pull.human_comments,
      revision: {
        id: pull.revision_id,
        state: (pull.revision_state ?? "pending") as ReviewRevisionState,
        complete: pull.complete ?? false,
        filesCount: pull.files_count ?? 0,
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        viewedCount: Number(pull.viewed_count ?? 0),
        commentCount: 0,
        error: pull.error,
      },
    })),
    acceptancePack: pack,
    autoMerge,
    tickets: tickets.rows.map((ticket) => {
      const displayId = formatDisplayId("ticket", ticket.id);
      return {
        id: ticket.id,
        displayId,
        title: ticket.title,
        stories: ticket.stories,
        criteria: criteriaByTicket.get(displayId) ?? [],
      };
    }),
    findings,
  };
}

export async function reviewRevisionOf(
  client: pg.PoolClient,
  pullId: number,
  headSha: string,
): Promise<ReviewRevisionView | { status: "not-found" }> {
  const pull = await client.query<{ id: number; head_sha: string }>(
    "SELECT id, head_sha FROM pull_requests WHERE id = $1",
    [pullId],
  );
  const row = pull.rows[0];
  if (!row) return { status: "not-found" };
  if (row.head_sha === headSha) await enqueueReviewRevision(client, pullId);
  const revision = await loadRevision(client, pullId, headSha);
  if (!revision) return { status: "not-found" };
  if (revision.state === "ready") return revision;
  if (row.head_sha !== headSha) return { status: "not-found" };
  if (revision.state === "failed") {
    return {
      state: "failed",
      id: revision.id,
      headSha,
      error: revision.error,
    };
  }
  return { state: "pending", id: revision.id, headSha };
}

async function loadRevision(
  db: Pick<pg.PoolClient, "query">,
  pullId: number,
  headSha: string,
): Promise<
  | Extract<ReviewRevisionView, { state: "ready" }>
  | {
      state: "pending" | "failed";
      id: number;
      headSha: string;
      error: string | null;
    }
  | undefined
> {
  const revision = await db.query<{
    id: number;
    state: string;
    head_sha: string;
    base_sha: string | null;
    merge_base_sha: string | null;
    previous_head_sha: string | null;
    complete: boolean;
    omitted_reason: string | null;
    files_count: number;
    additions: number;
    deletions: number;
    error: string | null;
  }>(
    `SELECT id, state, head_sha, base_sha, merge_base_sha, previous_head_sha,
            complete, omitted_reason, files_count, additions, deletions, error
     FROM review_revisions
     WHERE pull_request_id = $1 AND head_sha = $2`,
    [pullId, headSha],
  );
  const row = revision.rows[0];
  if (!row) return undefined;
  if (row.state !== "ready") {
    return {
      state: row.state as "pending" | "failed",
      id: row.id,
      headSha: row.head_sha,
      error: row.error,
    };
  }
  const files = await db.query<{
    id: number;
    path: string;
    old_path: string | null;
    status: string;
    old_blob: string;
    new_blob: string;
    additions: number;
    deletions: number;
    binary: boolean;
    generated: boolean;
    test: boolean;
    lockfile: boolean;
    patch_omitted: string | null;
    attributions: ReviewAttribution[];
    hunks: ReviewHunk[] | null;
    viewed: boolean;
  }>(
    `SELECT f.id, f.path, f.old_path, f.status, f.old_blob, f.new_blob,
            f.additions, f.deletions, f.binary, f.generated, f.test, f.lockfile,
            f.patch_omitted, f.attributions, f.hunks,
            (v.path IS NOT NULL) AS viewed
     FROM review_files f
     LEFT JOIN review_file_views v
       ON v.pull_request_id = $2 AND v.path = f.path AND v.new_blob = f.new_blob
     WHERE f.revision_id = $1
     ORDER BY f.path`,
    [row.id, pullId],
  );
  return {
    state: "ready",
    id: row.id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    mergeBaseSha: row.merge_base_sha,
    previousHeadSha: row.previous_head_sha,
    complete: row.complete,
    omittedReason: row.omitted_reason,
    filesCount: row.files_count,
    additions: row.additions,
    deletions: row.deletions,
    files: files.rows.map((file) => ({
      id: file.id,
      path: file.path,
      oldPath: file.old_path,
      status: file.status as ReviewFileStatus,
      oldBlob: file.old_blob,
      newBlob: file.new_blob,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      generated: file.generated,
      test: file.test,
      lockfile: file.lockfile,
      patchOmitted: file.patch_omitted as ReviewPatchOmittedReason | null,
      attributions: file.attributions,
      hunks: file.hunks,
      viewed: file.viewed,
    })),
  };
}

export async function reviewFilePatchOf(
  pool: Pick<pg.Pool, "query">,
  fileId: number,
  view: "all" | "since",
): Promise<ReviewFilePatchView | undefined> {
  const file = await pool.query<{
    id: number;
    path: string;
    patch: string | null;
    since_patch: string | null;
    patch_omitted: string | null;
  }>(
    "SELECT id, path, patch, since_patch, patch_omitted FROM review_files WHERE id = $1",
    [fileId],
  );
  const row = file.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    path: row.path,
    view,
    patch: view === "since" ? row.since_patch : row.patch,
    patchOmitted:
      view === "all"
        ? (row.patch_omitted as ReviewPatchOmittedReason | null)
        : null,
  };
}

export async function reviewBlobSliceOf(
  pool: Pick<pg.Pool, "query">,
  sha: string,
  from: number,
  to: number,
): Promise<ReviewBlobSliceView | undefined> {
  if (!GIT_SHA.test(sha)) return undefined;
  const referenced = await pool.query(
    `SELECT 1 FROM review_files WHERE old_blob = $1 OR new_blob = $1 LIMIT 1`,
    [sha],
  );
  if (!referenced.rowCount) return undefined;
  const blob = await pool.query<{ content: string }>(
    "SELECT content FROM review_blobs WHERE sha = $1",
    [sha],
  );
  const content = blob.rows[0]?.content;
  if (content === undefined) {
    return { sha, from, to, stored: false, lines: [] };
  }
  return { sha, from, to, stored: true, lines: blobLines(content, from, to) };
}

export async function pullExists(
  db: Pick<pg.PoolClient, "query">,
  pullId: number,
): Promise<boolean> {
  const row = await db.query("SELECT 1 FROM pull_requests WHERE id = $1", [
    pullId,
  ]);
  return (row.rowCount ?? 0) > 0;
}

export async function putReviewFileViewed(
  client: pg.PoolClient,
  input: { pullId: number; path: string; newBlob: string; viewedAt: Date },
): Promise<"ok" | "not-found"> {
  if (!(await pullExists(client, input.pullId))) return "not-found";
  await markReviewFileViewed(client, input);
  return "ok";
}

export async function deleteReviewFileViewed(
  client: pg.PoolClient,
  input: { pullId: number; path: string; newBlob: string },
): Promise<"ok" | "not-found"> {
  if (!(await pullExists(client, input.pullId))) return "not-found";
  await unmarkReviewFileViewed(client, input);
  return "ok";
}
