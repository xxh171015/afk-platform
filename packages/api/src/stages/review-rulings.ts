import {
  CODE_CHANGING_STAGES,
  checkReviewRulings,
  decisionLogFromRuns,
  formatDisplayId,
  listedDecisionsForReview,
  rulingsOf,
} from "@afk/shared";
import type pg from "pg";

function specAxisOutput(result: {
  run?: { axis?: string; output?: unknown };
  extraRuns?: { run: { axis?: string; output?: unknown } }[];
}): unknown {
  const runs = [
    result.run,
    ...(result.extraRuns ?? []).map((extra) => extra.run),
  ].filter((run): run is { axis?: string; output?: unknown } => run != null);
  const spec =
    runs.find((run) => run.axis === "spec") ?? runs.find((run) => !run.axis);
  return spec?.output;
}

function mustFixOf(output: unknown): { id?: string }[] {
  if (!output || typeof output !== "object") return [];
  const raw = (output as { mustFix?: unknown }).mustFix;
  if (!Array.isArray(raw)) return [];
  const items: { id?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    items.push(typeof id === "string" ? { id } : {});
  }
  return items;
}

export async function reviewOutcomeWithRulings(
  client: Pick<pg.Pool, "query">,
  input: {
    specId: number;
    ticketId: number | null;
    jobId: number;
    stage: string;
    outcome: string;
    run?: { axis?: string; output?: unknown };
    extraRuns?: { run: { axis?: string; output?: unknown } }[];
  },
): Promise<string> {
  if (input.stage !== "review" && input.stage !== "final-review")
    return input.outcome;
  if (input.outcome !== "pass" && input.outcome !== "fix") return input.outcome;
  const current = await client.query<{ id: number }>(
    "SELECT id FROM runs WHERE job_id = $1",
    [input.jobId],
  );
  const tickets = await client.query<{ id: number; state: string }>(
    "SELECT id, state FROM tickets WHERE spec_id = $1 ORDER BY id",
    [input.specId],
  );
  const runs = await client.query<{
    id: number;
    stage: string;
    ticket_id: number | null;
    axis: string | null;
    output: unknown;
  }>(
    `SELECT id, stage, ticket_id, axis, output FROM runs
     WHERE spec_id = $1 AND output IS NOT NULL AND (
       (stage = ANY($2) AND result = 'done')
       OR (stage IN ('review', 'final-review') AND result IN ('pass', 'fix'))
     )
     ORDER BY id`,
    [input.specId, [...CODE_CHANGING_STAGES]],
  );
  const log = decisionLogFromRuns({
    specDisplayId: formatDisplayId("spec", input.specId),
    ticketId: input.ticketId,
    ticketDisplayId:
      input.ticketId != null ? formatDisplayId("ticket", input.ticketId) : null,
    currentRunId: current.rows[0]?.id ?? null,
    tickets: tickets.rows,
    runs: runs.rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      ticketId: row.ticket_id,
      axis: row.axis,
      output: row.output,
    })),
  });
  const listed = listedDecisionsForReview(
    log,
    input.stage === "final-review" ? "spec" : "ticket",
  );
  const output = specAxisOutput(input);
  const check = checkReviewRulings({
    decisions: listed,
    rulings: rulingsOf(output),
    mustFix: mustFixOf(output),
  });
  return check.ok ? input.outcome : "invalid-output";
}
