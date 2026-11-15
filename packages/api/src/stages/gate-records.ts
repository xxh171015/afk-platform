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

export type GateTestCase = NonNullable<StoredGateRow["testCases"]>[number];

// SHA-256 of jsonb::text, same as the migration that copies old gate_results.test_cases.
export async function rememberGateTestCases(
  db: Queryable,
  cases: GateTestCase[] | undefined,
): Promise<string | null> {
  if (cases === undefined) return null;
  const payload = JSON.stringify(cases);
  const { rows } = await db.query<{ hash: string }>(
    `SELECT encode(sha256(convert_to(($1::jsonb)::text, 'UTF8')), 'hex') AS hash`,
    [payload],
  );
  const hash = rows[0]?.hash;
  if (!hash) return null;
  await db.query(
    `INSERT INTO gate_test_cases (hash, cases) VALUES ($1, $2::jsonb) ON CONFLICT (hash) DO NOTHING`,
    [hash, payload],
  );
  return hash;
}

export async function recallGateTestCases(
  db: Queryable,
  hash: string | null | undefined,
): Promise<GateTestCase[] | undefined> {
  if (!hash) return undefined;
  const { rows } = await db.query<{ cases: GateTestCase[] }>(
    "SELECT cases FROM gate_test_cases WHERE hash = $1",
    [hash],
  );
  return rows[0]?.cases;
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
    test_cases_hash: string | null;
  }>(
    `SELECT g.commit_sha, g.command_results, g.tests_total, g.tests_skipped, g.test_cases_hash
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
  const testCases = await recallGateTestCases(pool, row.test_cases_hash);
  return {
    commitSha: row.commit_sha,
    steps: row.command_results,
    counts: { tests: row.tests_total, skipped: row.tests_skipped ?? 0 },
    ...(testCases ? { testCases } : {}),
  };
}
