import { branchNames } from "@afk/shared";
import type pg from "pg";

// A repo the spec had not touched yet needs its integration branch before its first ticket runs: one is added for
// each of `repoIds` the spec does not have one for. The caller holds the spec row lock.
export async function ensureIntegrationBranches(
  client: pg.PoolClient,
  specId: number,
  repoIds: number[],
): Promise<void> {
  const { rows } = await client.query(
    "SELECT slug, branch_namespace, integration_branches FROM specs WHERE id = $1",
    [specId],
  );
  const spec = rows[0];
  const branches = spec.integration_branches as {
    repoId: number;
    branch: string;
  }[];
  const missing = [...new Set(repoIds)].filter(
    (repoId) => !branches.some((b) => b.repoId === repoId),
  );
  if (missing.length === 0) return;
  const branch = branchNames(spec.branch_namespace).integration(spec.slug);
  await client.query(
    "UPDATE specs SET integration_branches = $2 WHERE id = $1",
    [
      specId,
      JSON.stringify([
        ...branches,
        ...missing.map((repoId) => ({ repoId, branch })),
      ]),
    ],
  );
}
