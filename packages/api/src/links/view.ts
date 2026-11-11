import { formatDisplayId, type LinkKind } from "@afk/shared";
import type pg from "pg";

export interface LinkRow {
  kind: LinkKind;
  repo: string;
  sha: string;
  specId: number;
  specDisplayId: string;
  ticketId: number | null;
  ticketDisplayId: string | null;
  runId: number | null;
  runDisplayId: string | null;
  pullNumber: number | null;
}

interface LinkRecord {
  kind: LinkKind;
  repo: string;
  commit_sha: string;
  spec_id: number;
  ticket_id: number | null;
  run_id: number | null;
  pull_number: number | null;
}

function asLink(row: LinkRecord): LinkRow {
  return {
    kind: row.kind,
    repo: row.repo,
    sha: row.commit_sha,
    specId: row.spec_id,
    specDisplayId: formatDisplayId("spec", row.spec_id),
    ticketId: row.ticket_id,
    ticketDisplayId: row.ticket_id
      ? formatDisplayId("ticket", row.ticket_id)
      : null,
    runId: row.run_id,
    runDisplayId: row.run_id ? formatDisplayId("run", row.run_id) : null,
    pullNumber: row.pull_number,
  };
}

const SELECT = `SELECT l.kind, l.commit_sha, l.spec_id, l.ticket_id, l.run_id, r.name AS repo,
            p.number AS pull_number
     FROM links l JOIN repos r ON r.id = l.repo_id
     LEFT JOIN pull_requests p ON p.id = l.pull_request_id`;

export async function linksBySha(
  pool: pg.Pool,
  sha: string,
): Promise<LinkRow[]> {
  const { rows } = await pool.query<LinkRecord>(
    `${SELECT} WHERE l.commit_sha = $1 ORDER BY l.id`,
    [sha],
  );
  return rows.map(asLink);
}

export async function linksBySpec(
  pool: pg.Pool,
  specId: number,
): Promise<LinkRow[] | undefined> {
  const exists = await pool.query("SELECT 1 FROM specs WHERE id = $1", [
    specId,
  ]);
  if (!exists.rowCount) return undefined;
  const { rows } = await pool.query<LinkRecord>(
    `${SELECT} WHERE l.spec_id = $1 ORDER BY l.id`,
    [specId],
  );
  return rows.map(asLink);
}
