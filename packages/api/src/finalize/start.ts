import { specTransition } from "@afk/shared";
import type pg from "pg";
import { enqueueFinalJob } from "../jobs/stage-jobs.ts";

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

  const next = specTransition("running", "all-tickets-done");
  if (!next.ok) throw new Error(next.reason);
  await client.query("UPDATE specs SET state = $2 WHERE id = $1", [
    specId,
    next.state,
  ]);

  const repos = await client.query<{ repo_id: number }>(
    "SELECT DISTINCT repo_id FROM tickets WHERE spec_id = $1 AND state = 'done' ORDER BY repo_id",
    [specId],
  );
  for (const { repo_id: repoId } of repos.rows) {
    await client.query(
      "INSERT INTO finalizations (spec_id, repo_id) VALUES ($1, $2)",
      [specId, repoId],
    );
    await enqueueFinalJob(client, { specId, repoId }, "final-review");
  }
  return true;
}
