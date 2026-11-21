import {
  CODE_CHANGING_STAGES,
  checkReviewRulings,
  type DecisionLogItem,
  decisionLogFromRuns,
  formatDisplayId,
  isListedForRuling,
  listedDecisionsForReview,
  rulingsOf,
} from "@afk/shared";
import type pg from "pg";

export function specAxisOutput(
  result:
    | {
        run?: { axis?: string; output?: unknown };
        extraRuns?: { run: { axis?: string; output?: unknown } }[];
      }
    | undefined,
): unknown {
  if (!result) return undefined;
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

async function listedDecisionsForJob(
  client: Pick<pg.Pool, "query">,
  input: {
    specId: number;
    ticketId: number | null;
    jobId: number;
    stage: string;
  },
): Promise<DecisionLogItem[]> {
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
  return listedDecisionsForReview(
    log,
    input.stage === "final-review" ? "spec" : "ticket",
  );
}

export type NeedsHumanDecision = {
  id: string;
  text: string;
  run: string;
};

export async function needsHumanDecisionsOf(
  client: Pick<pg.Pool, "query">,
  input: {
    specId: number;
    ticketId: number;
    jobId: number;
    run?: { axis?: string; output?: unknown };
    extraRuns?: { run: { axis?: string; output?: unknown } }[];
  },
): Promise<NeedsHumanDecision[]> {
  const listed = await listedDecisionsForJob(client, {
    specId: input.specId,
    ticketId: input.ticketId,
    jobId: input.jobId,
    stage: "review",
  });
  const byId = new Map(
    rulingsOf(specAxisOutput(input)).map((ruling) => [ruling.id, ruling]),
  );
  return listed.flatMap((decision) => {
    if (!isListedForRuling(decision.kind)) return [];
    if (byId.get(decision.id)?.verdict !== "needs-human") return [];
    return [{ id: decision.id, text: decision.text, run: decision.run }];
  });
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
  const listed = await listedDecisionsForJob(client, input);
  const output = specAxisOutput(input);
  const check = checkReviewRulings({
    decisions: listed,
    rulings: rulingsOf(output),
    mustFix: mustFixOf(output),
  });
  return check.ok ? input.outcome : "invalid-output";
}
