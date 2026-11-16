import type pg from "pg";

// Auto-merge outcomes are not a column change: the API writes them the way a person's
// action is written (ADR 0008), in the same transaction as the job result.

export async function recordAutoMergeEvent(
  client: Pick<pg.PoolClient, "query">,
  input: {
    specId: number;
    repoId: number | null;
    outcome: "merged" | "failed";
    url: string;
    reason?: string;
  },
): Promise<void> {
  const type = input.outcome === "merged" ? "auto-merged" : "auto-merge-failed";
  const data: Record<string, unknown> = { url: input.url };
  if (input.reason) data.reason = input.reason;
  await client.query(
    `INSERT INTO events (spec_id, job_id, repo_id, type, reason, source, data)
     VALUES ($1, NULLIF(current_setting('afk.job_id', true), '')::integer, $2, $3, $4,
             NULLIF(current_setting('afk.source', true), ''), $5)`,
    [
      input.specId,
      input.repoId,
      type,
      input.reason ?? null,
      JSON.stringify(data),
    ],
  );
}
