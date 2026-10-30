import type pg from "pg";
import type { BundleRef } from "./bundle.ts";

// The repos a ticket reads, each with the SHA its snapshot is taken at: the head of the integration branch (what
// the last merge of the spec in that repo left), or null when nothing of the spec has merged there yet.
export async function refsOf(
  pool: pg.Pool,
  ticketId: number,
): Promise<BundleRef[]> {
  const { rows } = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
    sha: string | null;
  }>(
    `SELECT r.name, r.url, r.default_branch,
            (SELECT m.head_sha FROM runs m
             WHERE m.spec_id = t.spec_id AND m.repo_id = r.id AND m.stage = 'merge' AND m.result = 'merged'
             ORDER BY m.id DESC LIMIT 1) AS sha
     FROM tickets t
     JOIN specs s ON s.id = t.spec_id
     JOIN repos r ON r.project_id = s.project_id AND r.name = ANY(t.refs)
     WHERE t.id = $1
     ORDER BY array_position(t.refs, r.name)`,
    [ticketId],
  );
  return rows.map((row) => ({
    name: row.name,
    url: row.url,
    defaultBranch: row.default_branch,
    sha: row.sha,
  }));
}
