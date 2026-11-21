import type pg from "pg";
import type { BundleRef } from "./bundle.ts";

function asBundleRef(row: {
  name: string;
  url: string;
  default_branch: string;
  sha: string | null;
}): BundleRef {
  return {
    name: row.name,
    url: row.url,
    defaultBranch: row.default_branch,
    sha: row.sha,
  };
}

function unionRefsByName(first: BundleRef[], extra: BundleRef[]): BundleRef[] {
  const seen = new Set(first.map((ref) => ref.name));
  return [...first, ...extra.filter((ref) => !seen.has(ref.name))];
}

// Spec-level reference repos, snapshotted at the SHA pinned on confirm or refresh — not the
// default branch head. Empty when the spec named none.
async function specLevelRefs(
  pool: pg.Pool,
  specId: number,
): Promise<BundleRef[]> {
  const { rows } = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
    sha: string | null;
  }>(
    `SELECT r.name, r.url, r.default_branch, pin.ref->>'sha' AS sha
     FROM specs s
     CROSS JOIN LATERAL jsonb_array_elements(s.refs) WITH ORDINALITY AS pin(ref, ord)
     JOIN repos r ON r.id = (pin.ref->>'repoId')::int
     WHERE s.id = $1
     ORDER BY pin.ord`,
    [specId],
  );
  return rows.map(asBundleRef);
}

// The repos a ticket names in `column` (`refs`: the ones it reads, `environment`: the ones an integration
// environment is built from), each with the SHA its snapshot is taken at: the head of the integration branch (what
// the last merge of the spec in that repo left, the finalization's included), or null when nothing of the spec has merged there yet.
async function reposNamed(
  pool: pg.Pool,
  ticketId: number,
  column: "refs" | "environment",
): Promise<BundleRef[]> {
  const { rows } = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
    sha: string | null;
  }>(
    `SELECT r.name, r.url, r.default_branch,
            (SELECT m.head_sha FROM runs m
             WHERE m.spec_id = t.spec_id AND m.repo_id = r.id AND m.stage IN ('merge', 'final-merge', 'tidy-merge', 'update-branch') AND m.result = 'merged'
             ORDER BY m.id DESC LIMIT 1) AS sha
     FROM tickets t
     JOIN specs s ON s.id = t.spec_id
     JOIN repos r ON r.project_id = s.project_id AND r.name = ANY(t.${column})
     WHERE t.id = $1
     ORDER BY array_position(t.${column}, r.name)`,
    [ticketId],
  );
  return rows.map(asBundleRef);
}

export async function refsOf(
  pool: pg.Pool,
  ticketId: number,
): Promise<BundleRef[]> {
  const { rows } = await pool.query<{ spec_id: number }>(
    "SELECT spec_id FROM tickets WHERE id = $1",
    [ticketId],
  );
  const specId = rows[0]?.spec_id;
  if (specId === undefined) return [];
  return unionRefsByName(
    await specLevelRefs(pool, specId),
    await reposNamed(pool, ticketId, "refs"),
  );
}

export const environmentOf = (pool: pg.Pool, ticketId: number) =>
  reposNamed(pool, ticketId, "environment");

// Wrap-up: spec-level reference repos plus every non-cancelled ticket of this spec in this repo's refs.
export async function refsOfSpecRepo(
  pool: pg.Pool,
  specId: number,
  repoId: number,
): Promise<BundleRef[]> {
  const { rows } = await pool.query<{
    name: string;
    url: string;
    default_branch: string;
    sha: string | null;
  }>(
    `SELECT r.name, r.url, r.default_branch,
            (SELECT m.head_sha FROM runs m
             WHERE m.spec_id = t.spec_id AND m.repo_id = r.id AND m.stage IN ('merge', 'final-merge', 'tidy-merge', 'update-branch') AND m.result = 'merged'
             ORDER BY m.id DESC LIMIT 1) AS sha
     FROM tickets t
     JOIN specs s ON s.id = t.spec_id
     JOIN repos r ON r.project_id = s.project_id AND r.name = ANY(t.refs)
     WHERE t.spec_id = $1 AND t.repo_id = $2 AND t.state <> 'cancelled'
     ORDER BY t.id, array_position(t.refs, r.name)`,
    [specId, repoId],
  );
  return unionRefsByName(
    await specLevelRefs(pool, specId),
    rows.map(asBundleRef),
  );
}
