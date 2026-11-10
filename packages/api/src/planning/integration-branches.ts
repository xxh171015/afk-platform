import { branchNames } from "@afk/shared";
import type pg from "pg";

export type IntegrationBranch = {
  repoId: number;
  branch: string;
  mainSha?: string;
};

export function integrationBranch(
  repoId: number,
  branch: string,
  mainSha: string | null | undefined,
): IntegrationBranch {
  return mainSha ? { repoId, branch, mainSha } : { repoId, branch };
}

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
    mainSha?: string;
  }[];
  const missing = [...new Set(repoIds)].filter(
    (repoId) => !branches.some((b) => b.repoId === repoId),
  );
  if (missing.length === 0) return;
  const branch = branchNames(spec.branch_namespace).integration(spec.slug);
  const shas = await client.query<{
    id: number;
    default_sha: string | null;
  }>("SELECT id, default_sha FROM repos WHERE id = ANY($1::int[])", [missing]);
  const shaById = new Map(shas.rows.map((row) => [row.id, row.default_sha]));
  await client.query(
    "UPDATE specs SET integration_branches = $2 WHERE id = $1",
    [
      specId,
      JSON.stringify([
        ...branches,
        ...missing.map((repoId) =>
          integrationBranch(repoId, branch, shaById.get(repoId)),
        ),
      ]),
    ],
  );
}
