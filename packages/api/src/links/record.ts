import { AGENT_STAGES } from "@afk/shared";
import type pg from "pg";

const SHA = /^[0-9a-f]{40}$/;

const STAGES_FOR = {
  merge: AGENT_STAGES,
  "final-merge": ["final-fix"],
} as const;

// When a ticket or wrap-up fix merge advances the integration branch, write a ticket-kind Link for
// each rewritten commit that run recorded (docs/design.md「Git 操作规范」: Link stores the SHA after
// trailer rewrite). A wrap-up fix has no Ticket trailer, so ticket_id stays null.
export async function recordTicketLinks(
  client: pg.PoolClient,
  owner: { spec_id: number; repo_id: number; ticket_id: number | null },
  stage: keyof typeof STAGES_FOR,
): Promise<void> {
  const { rows } = await client.query<{ id: number; commits: string[] }>(
    `SELECT id, commits FROM runs
     WHERE spec_id = $1 AND repo_id = $2 AND ticket_id IS NOT DISTINCT FROM $3
       AND result = 'done' AND stage = ANY($4)
     ORDER BY id`,
    [owner.spec_id, owner.repo_id, owner.ticket_id, STAGES_FOR[stage]],
  );
  for (const run of rows) {
    for (const sha of run.commits ?? []) {
      if (!SHA.test(sha)) continue;
      await client.query(
        `INSERT INTO links (repo_id, commit_sha, spec_id, ticket_id, run_id, kind)
         VALUES ($1, $2, $3, $4, $5, 'ticket')
         ON CONFLICT (repo_id, commit_sha) DO NOTHING`,
        [owner.repo_id, sha, owner.spec_id, owner.ticket_id, run.id],
      );
    }
  }
}
