import {
  formatDisplayId,
  type HumanAction,
  retryPlan,
  type SpecState,
  specResumeTarget,
  specTransition,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import { readTicketEditFile } from "@afk/shared/ticket-files";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import {
  CLEANUP_GRACE_SECONDS,
  enqueueHostSync,
  enqueueSpecCleanup,
  inSeconds,
} from "../host/host-jobs.ts";
import {
  enqueueFinalReviewIfWaiting,
  enqueueUpdateBranch,
  holdFinalReviewForUpdate,
} from "../host/update-branch.ts";
import { enqueueStageJob } from "../jobs/stage-jobs.ts";
import {
  inTransaction,
  lockSpec,
  schedulePass,
} from "../scheduling/scheduler.ts";
import { followApprovedPaths, snapshotTicket } from "./versions.ts";

// What a person can do with a blocked ticket (docs/design.md「blocked 处理」): try again, approve protected path
// changes, or cancel. Every action moves the ticket through the shared state machine, then lets the scheduler
// look at the spec again, since a ticket changing state can free a slot or a downstream ticket.

interface TicketRow {
  id: number;
  spec_id: number;
  repo_id: number;
  state: TicketState;
  blocked_reason: string | null;
  content_version: number;
  allowed_protected_paths: string[];
}

async function loadLocked(
  client: pg.PoolClient,
  ticketId: number,
): Promise<TicketRow | undefined> {
  const found = await client.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  if (!found.rows[0]) return undefined;
  await lockSpec(client, found.rows[0].spec_id);
  const row = await client.query<TicketRow>(
    `SELECT id, spec_id, repo_id, state, blocked_reason, content_version, allowed_protected_paths
     FROM tickets WHERE id = $1`,
    [ticketId],
  );
  return row.rows[0];
}

export type ActionResult<T> =
  | ({ status: "ok" } & T)
  | { status: "no-ticket" }
  | { status: "refused"; message: string };

const refused = (message: string) => ({ status: "refused", message }) as const;

export type RetryMode = "continue" | "restart";

// Empty or whitespace is no note. The note is not ticket content.
export function parkedRetryNote(
  note: string | undefined | null,
): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

// continue keeps the branch and its commits; restart starts again from the integration branch. Either way the
// fix counts and the review start over, and the ticket goes back to pending for the scheduler. A Retry note
// (if any) is parked until the next Run is claimed.
export async function retryTicket(
  pool: pg.Pool,
  ticketId: number,
  mode: RetryMode,
  note?: string | null,
): Promise<ActionResult<{ state: TicketState }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    const next = ticketTransition(ticket.state, { type: "retry" });
    if (!next.ok) return refused(next.reason);
    if (ticket.blocked_reason === "upstream-cancelled") {
      // Back to pending it would wait for a ticket that is gone, for ever.
      const gone = await client.query<{ id: number }>(
        `SELECT u.id FROM edges e JOIN tickets u ON u.id = e.from_ticket_id
         WHERE e.to_ticket_id = $1 AND u.state = 'cancelled'`,
        [ticketId],
      );
      if (gone.rows.length > 0) {
        return refused(
          `${formatDisplayId("ticket", ticketId)} waits for ${gone.rows.map((r) => formatDisplayId("ticket", r.id)).join(", ")}, which was cancelled: cancel this ticket too, or import a replacement`,
        );
      }
    }
    const plan = retryPlan(mode === "continue" ? "resume" : "restart");
    await client.query(
      `UPDATE tickets SET state = 'pending', blocked_reason = NULL, fix_counts = $2, reviewed = false,
         restart = $3 AND resume_stage IS NULL, integration_rounds = 0,
         job_floor = (SELECT COALESCE(max(id), 0) FROM jobs),
         retry_note = $4
       WHERE id = $1`,
      [
        ticketId,
        JSON.stringify(plan.fixCounts),
        plan.deleteBranch,
        parkedRetryNote(note),
      ],
    );
    await recordAction(
      client,
      "retry",
      { specId: ticket.spec_id, ticketId },
      { mode, note: parkedRetryNote(note) },
    );
    await schedulePass(client, ticket.spec_id);
    const after = await client.query<{ state: TicketState }>(
      "SELECT state FROM tickets WHERE id = $1",
      [ticketId],
    );
    return { status: "ok", state: after.rows[0]?.state as TicketState };
  });
}

// Only for protected-path-changed: the paths the gate found are added to the ticket's approved paths and the
// ticket goes on from the gate.
export async function approveProtected(
  pool: pg.Pool,
  ticketId: number,
): Promise<ActionResult<{ approved: string[] }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    if (
      ticket.state !== "blocked" ||
      ticket.blocked_reason !== "protected-path-changed"
    ) {
      return refused(
        `only a ticket blocked by protected-path-changed can be approved; this one is ${ticket.state}${ticket.blocked_reason ? ` (${ticket.blocked_reason})` : ""}`,
      );
    }
    const gate = await client.query<{ unapproved: string[] | null }>(
      `SELECT output->'unapproved' AS unapproved FROM runs
       WHERE ticket_id = $1 AND stage = 'gate' AND result = 'protected-path-changed' ORDER BY id DESC LIMIT 1`,
      [ticketId],
    );
    const approved = gate.rows[0]?.unapproved;
    if (!approved || approved.length === 0) {
      return refused(
        "the gate run that found the protected paths has no record of which ones they were",
      );
    }
    const next = ticketTransition(ticket.state, { type: "approve-protected" });
    if (!next.ok || next.state === "blocked")
      return refused(next.ok ? "unexpected" : next.reason);
    const allowed = [
      ...new Set([...ticket.allowed_protected_paths, ...approved]),
    ];
    await client.query(
      "UPDATE tickets SET state = $2, blocked_reason = NULL, allowed_protected_paths = $3,\n         job_floor = (SELECT COALESCE(max(id), 0) FROM jobs) WHERE id = $1",
      [ticketId, next.state, allowed],
    );
    await followApprovedPaths(client, ticketId);
    await recordAction(
      client,
      "approve-protected",
      { specId: ticket.spec_id, ticketId },
      { paths: approved },
    );
    await enqueueStageJob(
      client,
      {
        id: ticket.id,
        specId: ticket.spec_id,
        repoId: ticket.repo_id,
        contentVersion: ticket.content_version,
      },
      "gate",
    );
    return { status: "ok", approved };
  });
}

// For any blocked ticket: more paths are added to its approved ones, for the next run. The ticket stays blocked;
// a retry is a separate decision. (The route checks the paths like the import's `protected_paths_ok`: non-empty text.)
export async function allowPaths(
  pool: pg.Pool,
  ticketId: number,
  paths: string[],
): Promise<ActionResult<{ allowed: string[] }>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    if (ticket.state !== "blocked") {
      return refused(
        `only a blocked ticket can be given more protected paths; this one is ${ticket.state}`,
      );
    }
    const allowed = [...new Set([...ticket.allowed_protected_paths, ...paths])];
    await client.query(
      "UPDATE tickets SET allowed_protected_paths = $2 WHERE id = $1",
      [ticketId, allowed],
    );
    await followApprovedPaths(client, ticketId);
    await recordAction(
      client,
      "allow-paths",
      { specId: ticket.spec_id, ticketId },
      { paths },
    );
    return { status: "ok", allowed };
  });
}

export type EditResult =
  | { status: "ok"; contentVersion: number; changed: boolean }
  | { status: "no-ticket" }
  | { status: "refused"; message: string }
  | { status: "invalid"; message: string };

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

// A pending or blocked ticket gets new content from a ticket file (what `plat ticket view --md` prints): only the
// title, body, modules and approved protected paths can change. The acceptance criteria are read out of the new
// body. The version goes up by one, and the snapshot of the new version is kept, only when something changed.
export async function editTicket(
  pool: pg.Pool,
  ticketId: number,
  fileText: string,
): Promise<EditResult> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    if (ticket.state !== "pending" && ticket.state !== "blocked") {
      return refused(
        `${formatDisplayId("ticket", ticketId)} is ${ticket.state}; only a pending or blocked ticket can be edited`,
      );
    }
    const current = await client.query(
      `SELECT t.spec_id, t.title, t.body, t.acceptance_criteria, t.modules, t.allowed_protected_paths, t.type,
              t.refs, t.environment, t.content_version, r.name AS repo
       FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE t.id = $1`,
      [ticketId],
    );
    const now = current.rows[0];
    const read = readTicketEditFile(fileText, now.spec_id as number);
    if (!read.ok) return { status: "invalid", message: read.errors.join("\n") };
    const edit = read.edit;
    const shown = formatDisplayId("ticket", ticketId);
    if (edit.id !== undefined && edit.id !== shown) {
      return {
        status: "invalid",
        message: `id: the file is of ${edit.id}, not ${shown}`,
      };
    }
    const edges = await client.query<{ from_ticket_id: number; kind: string }>(
      "SELECT from_ticket_id, kind FROM edges WHERE to_ticket_id = $1",
      [ticketId],
    );
    const upstream = (kind: string) =>
      edges.rows
        .filter((e) => e.kind === kind)
        .map((e) => formatDisplayId("ticket", e.from_ticket_id));
    // fields that cannot change may be left out; written, they must say what the ticket has
    const fixed: [string, string | string[] | undefined, string | string[]][] =
      [
        ["repo", edit.repo, now.repo],
        ["type", edit.type, now.type],
        ["contract", edit.contract, upstream("contract")],
        ["refs", edit.refs, now.refs],
        ["environment", edit.environment, now.environment],
        ["blocked_by", edit.blocked_by, upstream("blocks")],
      ];
    for (const [field, written, has] of fixed) {
      const differs = Array.isArray(written)
        ? !sameSet(written, has as string[])
        : written !== undefined && written !== has;
      if (differs) {
        return {
          status: "invalid",
          message: `${field}: a ticket's ${field} cannot be changed (the file has ${JSON.stringify(written)}, the ticket ${JSON.stringify(has)}); cancel the ticket and append a new one (plat tickets import --append)`,
        };
      }
    }

    const changes: [string, unknown][] = [];
    const change = (column: string, value: unknown, was: unknown) => {
      if (
        value !== undefined &&
        JSON.stringify(value) !== JSON.stringify(was)
      ) {
        changes.push([column, value]);
      }
    };
    change("title", edit.title, now.title);
    change("body", edit.body, now.body);
    change("acceptance_criteria", edit.acceptance, now.acceptance_criteria);
    change("modules", edit.modules, now.modules);
    change(
      "allowed_protected_paths",
      edit.protected_paths_ok,
      now.allowed_protected_paths,
    );
    if (changes.length === 0) {
      return {
        status: "ok",
        contentVersion: now.content_version as number,
        changed: false,
      };
    }
    const assignments = changes.map(([column], i) => `${column} = $${i + 2}`);
    const updated = await client.query<{ content_version: number }>(
      `UPDATE tickets SET ${assignments.join(", ")}, content_version = content_version + 1
       WHERE id = $1 RETURNING content_version`,
      [ticketId, ...changes.map(([, value]) => value)],
    );
    await snapshotTicket(client, ticketId);
    await recordAction(
      client,
      "edit-ticket",
      { specId: ticket.spec_id, ticketId },
      {
        version: updated.rows[0]?.content_version,
        fields: changes.map(([column]) => column),
      },
    );
    return {
      status: "ok",
      contentVersion: updated.rows[0]?.content_version as number,
      changed: true,
    };
  });
}

export interface CancelOutcome {
  cancelled: string[]; // display ids
  blocked: string[]; // downstream tickets put into blocked (upstream-cancelled)
  skipped: string[]; // downstream tickets that could not be touched because they are already under way
}

// By default the tickets that waited for this one go to blocked (upstream-cancelled), so a person decides what
// becomes of them; with cascade everything downstream is cancelled too.
export async function cancelTicket(
  pool: pg.Pool,
  ticketId: number,
  cascade: boolean,
): Promise<ActionResult<CancelOutcome>> {
  return inTransaction(pool, async (client) => {
    const ticket = await loadLocked(client, ticketId);
    if (!ticket) return { status: "no-ticket" };
    const cancelled = ticketTransition(ticket.state, { type: "cancel" });
    if (!cancelled.ok)
      return refused(
        `${cancelled.reason} (only a pending or blocked ticket can be cancelled)`,
      );

    const outcome: CancelOutcome = {
      cancelled: [formatDisplayId("ticket", ticketId)],
      blocked: [],
      skipped: [],
    };
    await client.query(
      "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = $1",
      [ticketId],
    );

    const edges = await client.query<{
      from_ticket_id: number;
      to_ticket_id: number;
    }>(
      `SELECT e.from_ticket_id, e.to_ticket_id FROM edges e JOIN tickets t ON t.id = e.to_ticket_id WHERE t.spec_id = $1`,
      [ticket.spec_id],
    );
    const below = new Map<number, number[]>();
    for (const edge of edges.rows)
      below.set(edge.from_ticket_id, [
        ...(below.get(edge.from_ticket_id) ?? []),
        edge.to_ticket_id,
      ]);
    const states = new Map(
      (
        await client.query<{ id: number; state: TicketState }>(
          "SELECT id, state FROM tickets WHERE spec_id = $1",
          [ticket.spec_id],
        )
      ).rows.map((row) => [row.id, row.state]),
    );

    // direct downstream, or everything below when cascading
    const queue = [...(below.get(ticketId) ?? [])];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const id = queue.shift() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = states.get(id) as TicketState;
      const display = formatDisplayId("ticket", id);
      if (cascade) {
        const next = ticketTransition(state, { type: "cancel" });
        if (next.ok) {
          await client.query(
            "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = $1",
            [id],
          );
          outcome.cancelled.push(display);
        } else if (state !== "cancelled" && state !== "done") {
          outcome.skipped.push(display);
        }
        queue.push(...(below.get(id) ?? []));
      } else {
        const next = ticketTransition(state, {
          type: "block",
          reason: "upstream-cancelled",
        });
        if (
          !next.ok &&
          state !== "blocked" &&
          state !== "cancelled" &&
          state !== "done"
        ) {
          outcome.skipped.push(display); // already under way: not ours to stop
        }
        if (next.ok) {
          await client.query(
            "UPDATE tickets SET state = 'blocked', blocked_reason = 'upstream-cancelled' WHERE id = $1",
            [id],
          );
          outcome.blocked.push(display);
        }
      }
    }
    await recordAction(
      client,
      "cancel-ticket",
      { specId: ticket.spec_id, ticketId },
      { cascade, cancelled: outcome.cancelled, blocked: outcome.blocked },
    );
    await schedulePass(client, ticket.spec_id);
    return { status: "ok", ...outcome };
  });
}

// The spec's state once its lock is held, so it cannot change under the caller; undefined for an unknown spec.
async function lockedSpecState(
  client: pg.PoolClient,
  specId: number,
): Promise<SpecState | undefined> {
  const found = await client.query("SELECT 1 FROM specs WHERE id = $1", [
    specId,
  ]);
  if (!found.rows[0]) return undefined;
  await lockSpec(client, specId);
  const current = await client.query<{ state: SpecState }>(
    "SELECT state FROM specs WHERE id = $1",
    [specId],
  );
  return current.rows[0]?.state;
}

// A paused spec goes on: retry may add agent time (the old resume), allow does not.
async function unpauseSpec(
  pool: pg.Pool,
  specId: number,
  action: Extract<HumanAction, "retry" | "allow">,
  extraSeconds: number,
): Promise<ActionResult<{ state: SpecState }>> {
  return inTransaction(pool, async (client) => {
    const state = await lockedSpecState(client, specId);
    if (!state) return { status: "no-ticket" };
    const allowed = specTransition(state, "resume");
    if (!allowed.ok) return refused(allowed.reason);
    const finals = await client.query(
      "SELECT 1 FROM finalizations WHERE spec_id = $1 LIMIT 1",
      [specId],
    );
    const pulls = await client.query<{
      state: "open" | "closed" | "merged";
    }>("SELECT state FROM pull_requests WHERE spec_id = $1", [specId]);
    const dest = specResumeTarget({
      hasFinalizations: (finals.rowCount ?? 0) > 0,
      pullStates: pulls.rows.map((row) => row.state),
    });
    await client.query(
      "UPDATE specs SET state = $2, pause_reason = NULL, budget_extra_seconds = budget_extra_seconds + $3 WHERE id = $1",
      [specId, dest, extraSeconds],
    );
    await recordAction(
      client,
      action,
      { specId },
      extraSeconds > 0 ? { extraSeconds } : {},
    );
    await schedulePass(client, specId);
    const after = await client.query<{ state: SpecState; project_id: number }>(
      "SELECT state, project_id FROM specs WHERE id = $1",
      [specId],
    );
    const row = after.rows[0];
    if (
      row &&
      (row.state === "running" ||
        row.state === "finalizing" ||
        row.state === "awaiting-review" ||
        row.state === "partially-merged")
    )
      await enqueueHostSync(client, row.project_id);
    if (row?.state === "finalizing") {
      const repos = await client.query<{ repo_id: number }>(
        "SELECT repo_id FROM finalizations WHERE spec_id = $1 AND state = 'active' ORDER BY repo_id",
        [specId],
      );
      for (const { repo_id: repoId } of repos.rows) {
        if (
          action === "retry" &&
          (await holdFinalReviewForUpdate(client, specId, repoId))
        )
          continue;
        await enqueueFinalReviewIfWaiting(client, specId, repoId);
      }
    }
    if (
      action === "retry" &&
      (row?.state === "awaiting-review" || row?.state === "partially-merged")
    ) {
      const conflicted = await client.query<{
        repo_id: number;
        default_sha: string | null;
      }>(
        `SELECT p.repo_id, r.default_sha
         FROM pull_requests p JOIN repos r ON r.id = p.repo_id
         WHERE p.spec_id = $1 AND p.state = 'open' AND p.conflicts_with_default`,
        [specId],
      );
      for (const pr of conflicted.rows) {
        if (pr.default_sha)
          await enqueueUpdateBranch(client, {
            specId,
            repoId: pr.repo_id,
            mainSha: pr.default_sha,
          });
      }
    }
    if (row?.state === "merged") await enqueueSpecCleanup(client, { specId });
    return { status: "ok", state: row?.state as SpecState };
  });
}

export async function resumeSpec(
  pool: pg.Pool,
  specId: number,
  extraSeconds = 0,
): Promise<ActionResult<{ state: SpecState }>> {
  return unpauseSpec(pool, specId, "retry", extraSeconds);
}

export async function allowSpec(
  pool: pg.Pool,
  specId: number,
): Promise<ActionResult<{ state: SpecState }>> {
  return unpauseSpec(pool, specId, "allow", 0);
}

// The whole spec is given up. Every ticket that has not finished is cancelled (one under way too), the jobs of the
// spec are failed so nothing more is claimed and a worker still holding one learns on its next call that it no
// longer does, and their Runs are closed. Done tickets and what was already merged stay as they are.
// A pull request the platform last saw open; the repo is given by its name, which is unique in the project.
export interface OpenPullRequest {
  repo: string;
  number: number;
  url: string;
}

export async function cancelSpec(
  pool: pg.Pool,
  specId: number,
  now: Date,
): Promise<
  ActionResult<{
    state: SpecState;
    cancelled: string[];
    pullRequests: OpenPullRequest[];
  }>
> {
  return inTransaction(pool, async (client) => {
    const state = await lockedSpecState(client, specId);
    if (!state) return { status: "no-ticket" };
    const next = specTransition(state, "cancel");
    if (!next.ok)
      return refused(`${next.reason}: a merged or cancelled spec is final`);
    // What a person has merged stays on main, so a spec with a pull request merged and another still open cannot be
    // cancelled (that would leave half of it): the open ones are to be merged or closed first. Merged and the rest
    // closed, it can be, and the clean-up then deletes the branches.
    const mixed = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM pull_requests WHERE spec_id = $1 AND state = 'merged')
         AND EXISTS (SELECT 1 FROM pull_requests WHERE spec_id = $1 AND state = 'open')`,
      [specId],
    );
    if (mixed.rowCount)
      return refused(
        "a pull request of this spec is merged and another is still open; merge the open ones, or close them, before cancelling",
      );
    await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
      specId,
      next.state,
    ]);

    const tickets = await client.query<{ id: number; state: TicketState }>(
      "SELECT id, state FROM tickets WHERE spec_id = $1 ORDER BY id",
      [specId],
    );
    const cancelled: number[] = [];
    for (const ticket of tickets.rows) {
      if (ticketTransition(ticket.state, { type: "spec-cancelled" }).ok)
        cancelled.push(ticket.id);
    }
    if (cancelled.length > 0) {
      await client.query(
        "UPDATE tickets SET state = 'cancelled', blocked_reason = NULL WHERE id = ANY($1)",
        [cancelled],
      );
    }
    // A planning docs patch the platform still held is not needed any more (ADR 0005).
    await client.query("UPDATE specs SET planning_patch = NULL WHERE id = $1", [
      specId,
    ]);
    // Every kind of job names its spec in the payload: stages, final steps, open-pr, the planning commit.
    await client.query(
      `UPDATE jobs SET state = 'failed', error = 'the spec was cancelled', lease_owner = NULL, lease_expires_at = NULL
       WHERE state IN ('queued', 'running') AND (payload->>'specId')::int = $1`,
      [specId],
    );
    await client.query(
      `UPDATE runs SET finished_at = now(), result = 'cancelled',
         duration_ms = LEAST(extract(epoch FROM (now() - started_at)) * 1000, 2147483647)::int,
         output = jsonb_build_object('error', 'the spec was cancelled')
       WHERE spec_id = $1 AND finished_at IS NULL`,
      [specId],
    );
    // After the jobs of the spec were stopped: the one that closes its pull requests and deletes its branches.
    await enqueueSpecCleanup(
      client,
      { specId },
      inSeconds(now, CLEANUP_GRACE_SECONDS),
    );
    // The slots its tickets held are free: the other specs of the project get a pass once this commits.
    await schedulePass(client, specId);
    // What the cleanup is going to close, for the person who cancelled.
    const open = await client.query<OpenPullRequest>(
      `SELECT r.name AS repo, p.number, p.url FROM pull_requests p JOIN repos r ON r.id = p.repo_id
       WHERE p.spec_id = $1 AND p.state = 'open' ORDER BY p.id`,
      [specId],
    );
    await recordAction(
      client,
      "cancel-spec",
      { specId },
      { cancelled: cancelled.map((id) => formatDisplayId("ticket", id)) },
    );
    return {
      status: "ok",
      state: next.state,
      cancelled: cancelled.map((id) => formatDisplayId("ticket", id)),
      pullRequests: open.rows,
    };
  });
}

// A person asks for the cleanup of a cancelled or merged spec again (it failed three times, or something was made
// after it ran). Nothing is queued twice.
export async function retrySpecCleanup(
  pool: pg.Pool,
  specId: number,
): Promise<ActionResult<{ queued: true }>> {
  return inTransaction(pool, async (client) => {
    const state = await lockedSpecState(client, specId);
    if (!state) return { status: "no-ticket" };
    if (state !== "cancelled" && state !== "merged")
      return refused(
        `the spec is ${state}: only a cancelled or merged spec is cleaned up`,
      );
    const waiting = await client.query(
      `SELECT 1 FROM jobs WHERE type = 'spec-cleanup' AND state IN ('queued', 'running')
         AND (payload->>'specId')::int = $1`,
      [specId],
    );
    if (waiting.rowCount)
      return refused("a clean-up of this spec is already waiting or running");
    await enqueueSpecCleanup(client, { specId });
    await recordAction(client, "retry-cleanup", { specId });
    return { status: "ok", queued: true };
  });
}
