import { type MergeOrder, mergeOrder } from "@afk/shared";
import type pg from "pg";

// The merge order of a spec's repos, from the contract edges between its tickets that have not been cancelled.
export async function mergeOrderOf(
  db: pg.Pool | pg.PoolClient,
  specId: number,
): Promise<MergeOrder> {
  const repos = await db.query<{ name: string }>(
    `SELECT DISTINCT r.name FROM tickets t JOIN repos r ON r.id = t.repo_id
     WHERE t.spec_id = $1 AND t.state <> 'cancelled' ORDER BY r.name`,
    [specId],
  );
  const relations = await db.query<{ from: string; to: string }>(
    `SELECT DISTINCT a.name AS "from", b.name AS "to" FROM edges e
     JOIN tickets u ON u.id = e.from_ticket_id JOIN repos a ON a.id = u.repo_id
     JOIN tickets d ON d.id = e.to_ticket_id JOIN repos b ON b.id = d.repo_id
     WHERE e.kind = 'contract' AND d.spec_id = $1 AND u.state <> 'cancelled' AND d.state <> 'cancelled'`,
    [specId],
  );
  return mergeOrder(
    repos.rows.map((r) => r.name),
    relations.rows,
  );
}
