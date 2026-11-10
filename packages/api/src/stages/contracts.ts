import type pg from "pg";
import type { BundleContract } from "./bundle.ts";

// The contracts a ticket builds against, one per repo that provides any: the file at the SHA of the most
// downstream contract ticket among the ticket's upstreams in that repo. The import guarantees those upstreams
// form a chain, so "most downstream" is the one the others lead to.
export async function contractsOf(
  pool: Pick<pg.Pool, "query">,
  ticketId: number,
): Promise<BundleContract[]> {
  const { rows } = await pool.query<{
    id: number;
    contract_sha: string;
    contract_path: string;
    name: string;
    url: string;
    default_branch: string;
  }>(
    `SELECT u.id, u.contract_sha, r.contract_path, r.name, r.url, r.default_branch
     FROM edges e JOIN tickets u ON u.id = e.from_ticket_id JOIN repos r ON r.id = u.repo_id
     WHERE e.to_ticket_id = $1 AND e.kind = 'contract' AND u.contract_sha IS NOT NULL
       AND r.contract_path IS NOT NULL
     ORDER BY r.name, u.id`,
    [ticketId],
  );
  if (rows.length === 0) return [];

  const edges = await pool.query<{
    from_ticket_id: number;
    to_ticket_id: number;
  }>(
    `SELECT e.from_ticket_id, e.to_ticket_id FROM edges e JOIN tickets t ON t.id = e.to_ticket_id
     WHERE t.spec_id = (SELECT spec_id FROM tickets WHERE id = $1)`,
    [ticketId],
  );
  const next = new Map<number, number[]>();
  for (const edge of edges.rows) {
    next.set(edge.from_ticket_id, [
      ...(next.get(edge.from_ticket_id) ?? []),
      edge.to_ticket_id,
    ]);
  }
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    return false;
  };

  const byRepo = new Map<string, typeof rows>();
  for (const row of rows) {
    byRepo.set(row.name, [...(byRepo.get(row.name) ?? []), row]);
  }
  return [...byRepo.values()].map((upstreams) => {
    const newest =
      upstreams.find(
        (candidate) =>
          upstreams.every(
            (other) =>
              other.id === candidate.id || reaches(other.id, candidate.id),
          ),
        // the import refuses upstreams that are not a chain; if old data has some, the newest ticket is the best guess
      ) ?? (upstreams.at(-1) as (typeof upstreams)[number]);
    return {
      repo: newest.name,
      url: newest.url,
      defaultBranch: newest.default_branch,
      sha: newest.contract_sha,
      path: newest.contract_path,
    };
  });
}
