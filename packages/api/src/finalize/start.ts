import { type SpecEvent, specTransition } from "@afk/shared";
import type pg from "pg";
import { enqueueSpecCleanup } from "../host/host-jobs.ts";
import { dropPotentialConflicts } from "../host/trial-merge.ts";
import { enqueueFinalJob } from "../jobs/stage-jobs.ts";

// A running spec takes the event; called with the spec locked.
async function moveRunningSpec(
  client: pg.PoolClient,
  specId: number,
  event: SpecEvent,
): Promise<void> {
  const next = specTransition("running", event);
  if (!next.ok) throw new Error(next.reason);
  await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
    specId,
    next.state,
  ]);
}

// When the last ticket of a running spec is done, the spec moves to finalizing and every repo it touched gets
// its overall review queued. Called by the scheduler with the spec locked, so it happens exactly once.
// Cancelled tickets do not hold it back; blocked, pending, queued, running and merging ones do.
export async function startFinalization(
  client: pg.PoolClient,
  specId: number,
): Promise<boolean> {
  const counts = await client.query<{ open: string; done: string }>(
    `SELECT count(*) FILTER (WHERE state NOT IN ('done', 'cancelled')) AS open,
            count(*) FILTER (WHERE state = 'done') AS done
     FROM tickets WHERE spec_id = $1`,
    [specId],
  );
  const { open, done } = counts.rows[0] as { open: string; done: string };
  if (Number(open) > 0 || Number(done) === 0) return false;

  await moveRunningSpec(client, specId, "all-tickets-done");

  const repos = await client.query<{ repo_id: number }>(
    "SELECT DISTINCT repo_id FROM tickets WHERE spec_id = $1 AND state = 'done' ORDER BY repo_id",
    [specId],
  );
  const { holdFinalReviewForUpdate } = await import("../host/update-branch.ts");
  for (const { repo_id: repoId } of repos.rows) {
    await client.query(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, $2)",
      [specId, repoId],
    );
    if (await holdFinalReviewForUpdate(client, specId, repoId)) continue;
    await enqueueFinalJob(client, { specId, repoId }, "final-review");
  }
  // Planning docs committed in a repo none of whose tickets got done: nothing to review, but the branch still
  // has to catch up with main before its pull request goes out (ADR 0005).
  const planning = await client.query<{
    planning_repo_id: number | null;
    planning_docs_committed: boolean;
  }>(
    "SELECT planning_repo_id, planning_docs_committed FROM specs WHERE id = $1",
    [specId],
  );
  const planningRepoId = planning.rows[0]?.planning_repo_id;
  if (
    planning.rows[0]?.planning_docs_committed &&
    planningRepoId != null &&
    !repos.rows.some((row) => row.repo_id === planningRepoId)
  ) {
    if (await holdFinalReviewForUpdate(client, specId, planningRepoId)) {
      await client.query(
        "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, $2)",
        [specId, planningRepoId],
      );
    } else {
      await client.query(
        "INSERT INTO finalizations (spec_id, repo_id, state) VALUES ($1, $2, 'done')",
        [specId, planningRepoId],
      );
    }
  }
  return true;
}

// A running spec whose tickets are all cancelled, with none done, has nothing to review or merge: it is cancelled
// too, instead of staying running for ever. Called by the scheduler with the spec locked, before startFinalization.
export async function cancelIfAllTicketsCancelled(
  client: pg.PoolClient,
  specId: number,
): Promise<boolean> {
  const counts = await client.query<{ cancelled: string; other: string }>(
    `SELECT count(*) FILTER (WHERE state = 'cancelled') AS cancelled,
            count(*) FILTER (WHERE state <> 'cancelled') AS other
     FROM tickets WHERE spec_id = $1`,
    [specId],
  );
  const { cancelled, other } = counts.rows[0] as {
    cancelled: string;
    other: string;
  };
  if (Number(other) > 0 || Number(cancelled) === 0) return false;

  await moveRunningSpec(client, specId, "cancel");
  await dropPotentialConflicts(client, specId);
  // the branches it made, like any cancelled spec's
  await enqueueSpecCleanup(client, { specId });
  return true;
}
