import {
  branchNames,
  type Capacity,
  formatDisplayId,
  type IncomingEdge,
  isRunnable,
  MAX_PLANNING_PATCH_BYTES,
  type PlanningState,
  resolveLimits,
  type SpecState,
  specTransition,
  type TicketState,
  ticketTransition,
} from "@afk/shared";
import type pg from "pg";
import { recordAction } from "../events/human-actions.ts";
import { applyOrigin, asSource } from "../events/origin.ts";
import {
  cancelIfAllTicketsCancelled,
  startFinalization,
} from "../finalize/start.ts";
import { enqueueHostSync } from "../host/host-jobs.ts";
import { redAccessProblem } from "../host/repo-access.ts";
import { enqueueStageJob } from "../jobs/stage-jobs.ts";
import { integrationBranch } from "../planning/integration-branches.ts";
import { enqueuePlanningCommit } from "../planning/planning-commit.ts";

// Confirming a split and deciding which tickets may start (docs/design.md「依赖边什么时候算满足」,
// docs/specs/m1-platform.md「并发与预算默认值」). The scheduler is the only thing that moves a ticket from
// pending to queued; it re-runs after a confirmation, after a ticket is done, and after a human retry.
//
// The project's slots are shared by its specs. Whatever made one spec run a pass (a ticket done, blocked, failed or
// cancelled, the spec cancelled or paused) may have freed a slot another spec waits for, so once that transaction
// commits every running spec of the project gets a pass of its own; the API also passes over every running spec
// now and then, for any trigger that was missed. Specs take turns: a slot goes to the spec holding fewer, and of two
// holding as many, to the one that started a ticket longer ago.

export interface ScheduledTicket {
  ticketId: number;
  displayId: string;
  jobId: number;
}

export interface ScheduleResult {
  enqueued: ScheduledTicket[];
  // Set when the spec's agent time ran out during this pass.
  paused: boolean;
}

// What `plat spec confirm` in the planning repo sends: the planning docs patch ("" when nothing changed). Absent
// when the spec is confirmed anywhere else, the page included.
export type ConfirmPlanning = { patch: string };

export type ConfirmResult =
  | {
      status: "ok";
      state: SpecState;
      integrationBranches: { repoId: number; branch: string }[];
      enqueued: ScheduledTicket[];
      planningRepo: string | null;
      planningState: PlanningState | null;
    }
  | { status: "no-spec" }
  | { status: "not-confirmable"; message: string }
  | { status: "invalid"; message: string };

// Scheduling passes and ticket completions of one spec take this lock, so they never interleave.
export async function lockSpec(
  client: pg.PoolClient,
  specId: number,
): Promise<void> {
  await client.query("SELECT 1 FROM specs WHERE id = $1 FOR UPDATE", [specId]);
}

// Projects whose specs get a pass once the transaction on this connection commits (see the top of the file).
const projectsToPass = new WeakMap<pg.PoolClient, Set<number>>();

function passProjectAfterCommit(client: pg.PoolClient, projectId: number) {
  const projects = projectsToPass.get(client) ?? new Set<number>();
  projects.add(projectId);
  projectsToPass.set(client, projects);
}

export async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  options: { passProjects?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  let result: T;
  let projects: Set<number> | undefined;
  try {
    // a transaction opened by hand on this connection may have left some behind
    projectsToPass.delete(client);
    await client.query("BEGIN");
    await applyOrigin(client);
    result = await work(client);
    await client.query("COMMIT");
    projects = projectsToPass.get(client);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    projectsToPass.delete(client);
    client.release();
  }
  if (projects && options.passProjects !== false) {
    for (const projectId of projects) {
      // what was committed stands; a pass that fails here is made up by the periodic one
      await scheduleProject(pool, projectId).catch((error) =>
        console.error(`scheduling project ${projectId} failed:`, error),
      );
    }
  }
  return result;
}

// draft -> planned -> running in one step, one integration branch (spec/<id>/<slug>) per repo the spec touches,
// then the first scheduling pass. A spec with a planning repo first gets its planning commit (ADR 0005): the job is
// queued here, and no ticket is scheduled until it is done.
export async function confirmSpec(
  pool: pg.Pool,
  specId: number,
  planning?: ConfirmPlanning,
): Promise<ConfirmResult> {
  return inTransaction(pool, async (client) => {
    const spec = await client.query(
      `SELECT s.slug, s.state, s.branch_namespace, s.planning_repo_id, s.project_id, r.name AS planning_repo
       FROM specs s LEFT JOIN repos r ON r.id = s.planning_repo_id WHERE s.id = $1 FOR UPDATE OF s`,
      [specId],
    );
    if (spec.rowCount === 0) return { status: "no-spec" };
    const {
      slug,
      state,
      branch_namespace,
      planning_repo_id,
      planning_repo,
      project_id,
    } = spec.rows[0] as {
      slug: string;
      state: SpecState;
      branch_namespace: string | null;
      planning_repo_id: number | null;
      planning_repo: string | null;
      project_id: number;
    };
    const planned = specTransition(state, "confirm-plan");
    if (!planned.ok) {
      return { status: "not-confirmable", message: planned.reason };
    }
    if (planning !== undefined && planning_repo_id === null) {
      return {
        status: "invalid",
        message: `${formatDisplayId("spec", specId)} has no planning repo to send planning docs to`,
      };
    }
    if (
      planning !== undefined &&
      Buffer.byteLength(planning.patch) > MAX_PLANNING_PATCH_BYTES
    ) {
      return {
        status: "invalid",
        message: `the planning docs patch is over ${MAX_PLANNING_PATCH_BYTES} bytes`,
      };
    }
    const repos = await client.query<{ repo_id: number }>(
      "SELECT DISTINCT repo_id FROM tickets WHERE spec_id = $1 ORDER BY repo_id",
      [specId],
    );
    if (repos.rowCount === 0) {
      return {
        status: "not-confirmable",
        message: `${formatDisplayId("spec", specId)} has no tickets to run`,
      };
    }
    const access = await client.query<{
      name: string;
      host_kind: string;
      access: {
        last?: {
          state?: string;
          fix?: string;
          username?: string;
          message?: string;
        };
      } | null;
    }>(
      `SELECT DISTINCT r.name, r.host_kind, r.access FROM tickets t JOIN repos r ON r.id = t.repo_id
       WHERE t.spec_id = $1 ORDER BY r.name`,
      [specId],
    );
    const red = access.rows
      .map((row) =>
        redAccessProblem(row.name, {
          ...row.access?.last,
          hostKind: row.host_kind,
        }),
      )
      .filter((line): line is string => line !== undefined);
    if (red.length > 0)
      return { status: "not-confirmable", message: red.join("\n") };
    const running = specTransition(planned.state, "start");
    if (!running.ok) throw new Error(running.reason);
    const repoIds = [
      ...new Set([
        ...repos.rows.map((row) => row.repo_id),
        ...(planning_repo_id === null ? [] : [planning_repo_id]),
      ]),
    ].sort((a, b) => a - b);
    const shas = await client.query<{
      id: number;
      default_sha: string | null;
    }>("SELECT id, default_sha FROM repos WHERE id = ANY($1::int[])", [
      repoIds,
    ]);
    const shaById = new Map(shas.rows.map((row) => [row.id, row.default_sha]));
    const storedBranches = repoIds.map((repoId) =>
      integrationBranch(
        repoId,
        branchNames(branch_namespace).integration(slug),
        shaById.get(repoId),
      ),
    );
    const integrationBranches = storedBranches.map(({ repoId, branch }) => ({
      repoId,
      branch,
    }));
    await client.query(
      "UPDATE specs SET state = $2, integration_branches = $3, planning_patch = $4 WHERE id = $1",
      [
        specId,
        running.state,
        JSON.stringify(storedBranches),
        planning?.patch ? planning.patch : null,
      ],
    );
    if (planning_repo_id !== null) await enqueuePlanningCommit(client, specId);
    await recordAction(client, "confirm", { specId });
    const scheduled = await schedulePass(client, specId);
    if (!scheduled.paused) await enqueueHostSync(client, project_id);
    return {
      status: "ok",
      state: scheduled.paused ? "paused" : running.state,
      integrationBranches,
      enqueued: scheduled.enqueued,
      planningRepo: planning_repo,
      planningState: planning_repo_id === null ? null : "pending",
    };
  });
}

// Recomputes which pending tickets of a running spec can start and queues an implement job for each.
// Safe to call at any time and any number of times: the spec row lock serialises passes, and a ticket that was
// queued is no longer pending.
export async function scheduleSpec(
  pool: pg.Pool,
  specId: number,
  options: { passProjects?: boolean } = {},
): Promise<ScheduleResult> {
  return inTransaction(
    pool,
    async (client) => {
      await lockSpec(client, specId);
      return schedulePass(client, specId);
    },
    options,
  );
}

// A pass for every running spec of the project, each in its own transaction (so the spec-then-project lock order
// holds). Repeated while a round changes something: a spec may have left a slot to one that then paused instead.
export async function scheduleProject(
  pool: pg.Pool,
  projectId: number,
): Promise<ScheduleResult> {
  const enqueued: ScheduledTicket[] = [];
  for (let round = 0; round < 10; round++) {
    const specs = await pool.query<{ id: number }>(
      "SELECT id FROM specs WHERE project_id = $1 AND state = 'running' ORDER BY id",
      [projectId],
    );
    let changed = false;
    for (const { id } of specs.rows) {
      const pass = await scheduleSpec(pool, id, { passProjects: false });
      enqueued.push(...pass.enqueued);
      if (pass.enqueued.length > 0 || pass.paused) changed = true;
    }
    if (!changed) break;
  }
  return { enqueued, paused: false };
}

// The periodic pass the API makes over every project with a running spec.
export async function scheduleRunningSpecs(
  pool: pg.Pool,
): Promise<ScheduleResult> {
  const projects = await pool.query<{ project_id: number }>(
    "SELECT DISTINCT project_id FROM specs WHERE state = 'running' ORDER BY project_id",
  );
  const enqueued: ScheduledTicket[] = [];
  for (const { project_id } of projects.rows) {
    enqueued.push(...(await scheduleProject(pool, project_id)).enqueued);
  }
  return { enqueued, paused: false };
}

interface TicketRow {
  id: number;
  repo_id: number;
  state: TicketState;
  content_version: number;
  contract_sha: string | null;
  resume_stage: "e2e" | null;
}

// Whatever transaction it runs in, what a pass changes is the scheduler's doing.
export function schedulePass(
  client: pg.PoolClient,
  specId: number,
): Promise<ScheduleResult> {
  return asSource(client, "scheduler", () => schedulingPass(client, specId));
}

async function schedulingPass(
  client: pg.PoolClient,
  specId: number,
): Promise<ScheduleResult> {
  const none: ScheduleResult = { enqueued: [], paused: false };
  const spec = await client.query<{
    state: SpecState;
    project_id: number;
    budget_extra_seconds: number;
    planning_state: PlanningState | null;
  }>(
    "SELECT state, project_id, budget_extra_seconds, planning_state FROM specs WHERE id = $1",
    [specId],
  );
  const row = spec.rows[0];
  if (!row) return none;
  // whatever brought this pass about may have freed a slot for another spec of the project
  passProjectAfterCommit(client, row.project_id);
  if (row.state !== "running") return none;
  // Nothing left to run: the spec moves on to its overall review instead of being scheduled, or, when every
  // ticket was cancelled, is cancelled itself.
  if (await cancelIfAllTicketsCancelled(client, specId)) return none;
  // No ticket starts before the planning commit is there (ADR 0005).
  if (row.planning_state === "pending" || row.planning_state === "blocked")
    return none;
  if (await startFinalization(client, specId)) return none;

  // Concurrency is counted across the project's specs, so passes of different specs must not interleave
  // either. Always spec first, then project: the same order everywhere, so no deadlock.
  const project = await client.query(
    "SELECT limits, max_concurrency FROM projects WHERE id = $1 FOR UPDATE",
    [row.project_id],
  );
  const { limits: stored, max_concurrency: maxConcurrency } = project.rows[0];
  const limits = resolveLimits({
    ...(maxConcurrency ? { projectConcurrency: maxConcurrency } : {}),
    ...stored,
  });

  if (
    (await agentSecondsUsed(client, specId, limits.runWallclockSeconds)) >=
    limits.specAgentSeconds + row.budget_extra_seconds
  ) {
    const paused = specTransition(row.state, "pause");
    if (!paused.ok) throw new Error(paused.reason);
    await client.query(
      "UPDATE specs SET state = $2, pause_reason = $3 WHERE id = $1",
      [specId, paused.state, "budget-exhausted"],
    );
    return { enqueued: [], paused: true };
  }

  const tickets = await startableTickets(client, specId);
  const usage = await concurrencyInUse(client, row.project_id);
  const rivals = await rivalsFor(client, row.project_id, specId);
  const ownTurn = await client.query<{ last_started_at: Date | null }>(
    "SELECT last_started_at FROM specs WHERE id = $1",
    [specId],
  );
  const self = {
    id: specId,
    lastStartedAt: ownTurn.rows[0]?.last_started_at ?? null,
  };
  const enqueued: ScheduledTicket[] = [];
  for (const ticket of tickets) {
    const projectUsed = usage.project;
    const repoUsed = usage.repos.get(ticket.repo_id) ?? 0;
    const capacity: Capacity[] = [
      {
        scope: "project",
        resource: "concurrency",
        used: projectUsed,
        max: limits.projectConcurrency,
      },
      {
        scope: "repo",
        resource: "concurrency",
        used: repoUsed,
        max: limits.repoConcurrency,
      },
    ];
    const verdict = isRunnable({
      state: ticket.state,
      edges: ticket.edges,
      limits: capacity,
    });
    if (!verdict.runnable) continue;
    // a spec that has waited longer, and could start a ticket now, goes first
    const held = usage.specs.get(specId) ?? 0;
    const waiting = rivals.some(
      (rival) =>
        rival.repos.some(
          (repo) => (usage.repos.get(repo) ?? 0) < limits.repoConcurrency,
        ) && goesBefore(rival, usage.specs.get(rival.id) ?? 0, self, held),
    );
    if (waiting) break;

    const queued = ticketTransition(ticket.state, { type: "enqueue" });
    if (!queued.ok) throw new Error(queued.reason);
    await client.query("UPDATE tickets SET state = $2 WHERE id = $1", [
      ticket.id,
      queued.state,
    ]);
    const job = await enqueueStageJob(
      client,
      {
        id: ticket.id,
        specId,
        repoId: ticket.repo_id,
        contentVersion: ticket.content_version,
      },
      // a ticket that is merged already (its e2e failed, and the fix is done) starts again from its e2e
      ticket.resume_stage ?? "implement",
    );
    usage.project += 1;
    usage.repos.set(ticket.repo_id, repoUsed + 1);
    usage.specs.set(specId, held + 1);
    enqueued.push({
      ticketId: ticket.id,
      displayId: formatDisplayId("ticket", ticket.id),
      jobId: job.id,
    });
  }
  if (enqueued.length > 0) {
    await client.query(
      "UPDATE specs SET last_started_at = clock_timestamp() WHERE id = $1",
      [specId],
    );
  }
  return { enqueued, paused: false };
}

// The pending tickets of a spec whose edges are satisfied, each with its incoming edges; slots are not looked at.
async function startableTickets(
  client: pg.PoolClient,
  specId: number,
): Promise<(TicketRow & { edges: IncomingEdge[] })[]> {
  const tickets = await client.query<TicketRow>(
    "SELECT id, repo_id, state, content_version, contract_sha, resume_stage FROM tickets WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  const byId = new Map(tickets.rows.map((ticket) => [ticket.id, ticket]));
  const edges = await client.query<{
    from_ticket_id: number;
    to_ticket_id: number;
    kind: "blocks" | "contract";
  }>(
    `SELECT e.from_ticket_id, e.to_ticket_id, e.kind FROM edges e
     JOIN tickets t ON t.id = e.to_ticket_id WHERE t.spec_id = $1`,
    [specId],
  );
  const incoming = new Map<number, IncomingEdge[]>();
  for (const edge of edges.rows) {
    const blocker = byId.get(edge.from_ticket_id);
    const list = incoming.get(edge.to_ticket_id) ?? [];
    // Imports reject edges to other specs in M1; if one ever exists, it blocks rather than crashes the pass.
    list.push(
      blocker
        ? {
            kind: edge.kind,
            scope: "same-spec",
            blockerState: blocker.state,
            ...(blocker.contract_sha
              ? { contractSha: blocker.contract_sha }
              : {}),
          }
        : { kind: edge.kind, scope: "cross-spec", satisfied: false },
    );
    incoming.set(edge.to_ticket_id, list);
  }
  return tickets.rows
    .map((ticket) => ({ ...ticket, edges: incoming.get(ticket.id) ?? [] }))
    .filter(
      (ticket) =>
        ticket.state === "pending" &&
        isRunnable({ state: ticket.state, edges: ticket.edges, limits: [] })
          .runnable,
    );
}

interface Turn {
  id: number;
  lastStartedAt: Date | null;
}

// The other running specs of the project that have a ticket to start, with the repos those tickets are in.
async function rivalsFor(
  client: pg.PoolClient,
  projectId: number,
  specId: number,
): Promise<(Turn & { repos: number[] })[]> {
  const specs = await client.query<{
    id: number;
    last_started_at: Date | null;
  }>(
    `SELECT id, last_started_at FROM specs WHERE project_id = $1 AND id <> $2 AND state = 'running'
       AND (planning_state IS NULL OR planning_state NOT IN ('pending', 'blocked'))
     ORDER BY id`,
    [projectId, specId],
  );
  const rivals: (Turn & { repos: number[] })[] = [];
  for (const spec of specs.rows) {
    const repos = [
      ...new Set(
        (await startableTickets(client, spec.id)).map((t) => t.repo_id),
      ),
    ];
    if (repos.length > 0)
      rivals.push({
        id: spec.id,
        lastStartedAt: spec.last_started_at,
        repos,
      });
  }
  return rivals;
}

// Whether `a`, holding `heldA` slots, is owed the next slot before `b`: fewer slots first, then the one that started
// a ticket longer ago (never counts as longest), then the older spec.
function goesBefore(a: Turn, heldA: number, b: Turn, heldB: number): boolean {
  if (heldA !== heldB) return heldA < heldB;
  const startedA = a.lastStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const startedB = b.lastStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (startedA !== startedB) return startedA < startedB;
  return a.id < b.id;
}

// A queued or running ticket holds an agent run, whatever spec it belongs to.
async function concurrencyInUse(client: pg.PoolClient, projectId: number) {
  const { rows } = await client.query<{
    spec_id: number;
    repo_id: number;
    used: string;
  }>(
    `SELECT t.spec_id, t.repo_id, count(*) AS used FROM tickets t JOIN specs s ON s.id = t.spec_id
     WHERE s.project_id = $1 AND t.state IN ('queued', 'running') GROUP BY t.spec_id, t.repo_id`,
    [projectId],
  );
  const repos = new Map<number, number>();
  const specs = new Map<number, number>();
  for (const row of rows) {
    const used = Number(row.used);
    repos.set(row.repo_id, (repos.get(row.repo_id) ?? 0) + used);
    specs.set(row.spec_id, (specs.get(row.spec_id) ?? 0) + used);
  }
  return {
    project: rows.reduce((sum, row) => sum + Number(row.used), 0),
    repos,
    specs,
  };
}

// Finished runs count what they took; a run still going counts the time since it started, but never more than a
// run is allowed to take (so one whose worker died does not eat the budget for ever).
async function agentSecondsUsed(
  client: pg.PoolClient,
  specId: number,
  runWallclockSeconds: number,
): Promise<number> {
  const { rows } = await client.query<{ ms: string }>(
    `SELECT COALESCE(sum(COALESCE(duration_ms,
              LEAST(extract(epoch FROM (now() - started_at)) * 1000, $2::float8))), 0) AS ms
     FROM runs WHERE spec_id = $1 AND stage <> 'e2e' AND (duration_ms IS NOT NULL OR (started_at IS NOT NULL AND finished_at IS NULL))`,
    [specId, runWallclockSeconds * 1000],
  );
  return Number(rows[0]?.ms) / 1000;
}

export type CompleteTicketResult =
  | { status: "ok"; schedule: ScheduleResult }
  | { status: "no-ticket" }
  | { status: "not-mergeable"; message: string }
  | { status: "missing-contract-sha" };

// The merge stage's last step: the ticket is on the integration branch and its post-merge gate passed.
// A contract ticket records the integration branch head as the contract SHA, which is what satisfies its
// contract edges. Then the spec is scheduled again, because downstream tickets may now be free.
export async function completeTicket(
  pool: pg.Pool,
  ticketId: number,
  options: { contractSha?: string } = {},
): Promise<CompleteTicketResult> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ spec_id: number }>(
      "SELECT spec_id FROM tickets WHERE id = $1",
      [ticketId],
    );
    if (!found.rows[0]) return { status: "no-ticket" };
    await lockSpec(client, found.rows[0].spec_id);
    return finishTicket(client, ticketId, options.contractSha);
  });
}

// The caller holds the spec lock.
export async function finishTicket(
  client: pg.PoolClient,
  ticketId: number,
  contractSha?: string,
): Promise<CompleteTicketResult> {
  const found = await client.query<{
    spec_id: number;
    state: TicketState;
    type: string;
  }>("SELECT spec_id, state, type FROM tickets WHERE id = $1", [ticketId]);
  const ticket = found.rows[0];
  if (!ticket) return { status: "no-ticket" };
  const done = ticketTransition(ticket.state, { type: "merge-succeeded" });
  if (!done.ok) return { status: "not-mergeable", message: done.reason };
  const isContract = ticket.type === "contract";
  if (isContract && !contractSha) return { status: "missing-contract-sha" };
  await client.query(
    "UPDATE tickets SET state = $2, contract_sha = $3 WHERE id = $1",
    [ticketId, done.state, isContract ? (contractSha as string) : null],
  );
  return { status: "ok", schedule: await schedulePass(client, ticket.spec_id) };
}
