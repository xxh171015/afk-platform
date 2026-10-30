import { formatDisplayId, type TicketState } from "@afk/shared";
import type pg from "pg";

// What an integration ticket's e2e runs came to: each one, with the diagnosis after it and the fix ticket that
// diagnosis made. Shared by the ticket's page, the briefs of blocked tickets and the acceptance pack.

export interface IntegrationAttempt {
  e2e: {
    id: number;
    displayId: string;
    result: string | null;
    testsTotal: number | null;
    testsFailed: number | null;
    envUpMs: number | null;
    refShas: Record<string, string> | null;
    headSha: string | null;
  };
  // the diagnosis that followed a failed e2e (not the one before the pull request, which makes no fix ticket)
  diagnosis: {
    result: string | null;
    failingRepo: string | null;
    evidence: string;
    failingTests: string[];
  } | null;
  fixTicket: {
    id: number;
    displayId: string;
    state: TicketState;
    repo: string;
  } | null;
}

// Each e2e of an integration ticket in the order they ran, with the diagnosis that came after it and the fix
// ticket that diagnosis made (the k-th diagnosed one belongs to the k-th fix ticket). Empty for a ticket that has
// not run an e2e.
export async function integrationAttempts(
  pool: Pick<pg.Pool, "query">,
  ticketId: number,
): Promise<IntegrationAttempt[]> {
  const { rows } = await pool.query(
    `SELECT id, stage, result, output, tests_total, tests_failed, env_up_ms, ref_shas, head_sha FROM runs
     WHERE ticket_id = $1 AND stage IN ('e2e', 'diagnose') ORDER BY id`,
    [ticketId],
  );
  const fixes = await pool.query(
    `SELECT t.id, t.state, r.name AS repo FROM tickets t JOIN repos r ON r.id = t.repo_id
     WHERE t.fix_for_ticket_id = $1 ORDER BY t.fix_round`,
    [ticketId],
  );
  const attempts: IntegrationAttempt[] = [];
  let diagnosed = 0;
  for (const row of rows) {
    if (row.stage === "e2e") {
      attempts.push({
        e2e: {
          id: row.id,
          displayId: formatDisplayId("run", row.id),
          result: row.result ?? null,
          testsTotal: row.tests_total ?? null,
          testsFailed: row.tests_failed ?? null,
          envUpMs: row.env_up_ms ?? null,
          refShas: row.ref_shas ?? null,
          headSha: row.head_sha ?? null,
        },
        diagnosis: null,
        fixTicket: null,
      });
      continue;
    }
    const attempt = attempts.at(-1);
    if (!attempt || attempt.diagnosis) continue;
    const said = (row.output ?? {}) as {
      result?: string;
      failingRepo?: string | null;
      evidence?: string;
      failingTests?: string[];
    };
    attempt.diagnosis = {
      result: said.result ?? null,
      failingRepo: said.failingRepo ?? null,
      evidence: said.evidence ?? "",
      failingTests: said.failingTests ?? [],
    };
    if (row.result === "diagnosed") {
      const fix = fixes.rows[diagnosed];
      diagnosed += 1;
      if (fix)
        attempt.fixTicket = {
          id: fix.id,
          displayId: formatDisplayId("ticket", fix.id),
          state: fix.state,
          repo: fix.repo,
        };
    }
  }
  return attempts;
}
