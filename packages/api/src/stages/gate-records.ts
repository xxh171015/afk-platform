import type { Queryable } from "../jobs/queue.ts";

// What a worker may ask about earlier gates of the repo its job is on (docs/design.md「门禁」): a passing result of the
// same tree under the same gates.yaml, to reuse instead of running the commands again. Only results whose commands all
// exited 0 and that read a JUnit report count: a stored pass is judged against the baseline again where it is reused.

export interface GateLookup {
  tree: string;
  configBlob: string;
}

export interface StoredGateRow {
  commitSha: string;
  steps: { name: string; exitCode: number; ms: number }[];
  counts: { tests: number; skipped: number };
  testCases?: {
    name: string;
    classname: string;
    status: "passed" | "failed" | "skipped";
    file?: string;
    message?: string;
    flaky?: boolean;
  }[];
}

export async function findPassingGate(
  pool: Queryable,
  jobId: number,
  lookup: GateLookup,
): Promise<StoredGateRow | null> {
  const { rows } = await pool.query<{
    commit_sha: string;
    command_results: { name: string; exitCode: number; ms: number }[];
    tests_total: number;
    tests_skipped: number | null;
    test_cases: StoredGateRow["testCases"] | null;
  }>(
    `SELECT g.commit_sha, g.command_results, g.tests_total, g.tests_skipped, g.test_cases
     FROM jobs j JOIN gate_results g ON g.repo_id = (j.payload->>'repoId')::int
     WHERE j.id = $1 AND g.tree_sha = $2 AND g.config_blob = $3 AND g.kind = 'gate' AND g.tests_total IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(g.command_results) s WHERE (s->>'exitCode')::int <> 0
       )
     ORDER BY g.id DESC LIMIT 1`,
    [jobId, lookup.tree, lookup.configBlob],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    commitSha: row.commit_sha,
    steps: row.command_results,
    counts: { tests: row.tests_total, skipped: row.tests_skipped ?? 0 },
    ...(row.test_cases ? { testCases: row.test_cases } : {}),
  };
}
