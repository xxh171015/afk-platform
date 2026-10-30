import { formatDisplayId } from "@afk/shared";
import { z } from "@hono/zod-openapi";
import type pg from "pg";

// The acceptance pack: what a person needs to decide whether to merge a spec's pull requests
// (docs/design.md「合并到 main 与信任阶梯」). It is built from what the platform recorded, once, when the
// spec's pull requests are all open; the pull request list is read live when the pack is shown, since CI and
// reviews keep changing.

const Step = z.object({
  name: z.string(),
  exitCode: z.number().int(),
  ms: z.number().int(),
});

export const PullRequestRow = z.object({
  order: z.number().int(), // the order to merge them in, 1 first
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  ci: z.enum(["none", "pending", "success", "failure"]),
  review: z.enum(["none", "approved", "changes-requested"]),
  syncError: z.string().nullable(),
});
export type PullRequestRow = z.infer<typeof PullRequestRow>;

export const AcceptancePack = z.object({
  generatedAt: z.string(),
  pullRequests: z.array(PullRequestRow),
  tickets: z.array(
    z.object({
      displayId: z.string(),
      title: z.string(),
      criteria: z.array(
        z.object({
          text: z.string(),
          tests: z.array(z.string()), // what the agent named
          status: z.enum(["verified", "unverified"]),
          reason: z.string().nullable(), // why it is not verified
        }),
      ),
    }),
  ),
  findings: z.array(
    z.object({
      ticket: z.string().nullable(),
      run: z.string(),
      stage: z.string(),
      kind: z.string(),
      body: z.string(),
      resolution: z.string(),
    }),
  ),
  uncertainties: z.array(z.object({ source: z.string(), text: z.string() })),
  gates: z.array(
    z.object({
      repo: z.string(),
      commitSha: z.string(),
      testsTotal: z.number().int().nullable(),
      testsSkipped: z.number().int().nullable(),
      durationMs: z.number().int(),
      steps: z.array(Step),
    }),
  ),
  protectedPathApprovals: z.array(
    z.object({ ticket: z.string(), paths: z.array(z.string()) }),
  ),
  agentSeconds: z.number().int(),
});
export type AcceptancePack = z.infer<typeof AcceptancePack>;

// The backend goes first: the frontend depends on it, so its pull request is merged (and deployed) before.
const mergeOrder = (a: { role: string; id: number }, b: typeof a) =>
  Number(b.role === "backend") - Number(a.role === "backend") || a.id - b.id;

export async function pullRequestRows(
  pool: Pick<pg.Pool, "query">,
  specId: number,
): Promise<PullRequestRow[]> {
  const { rows } = await pool.query(
    `SELECT r.id AS repo_id, r.role, p.number, p.url, p.state, p.draft, p.ci, p.review, p.sync_error
     FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.spec_id = $1`,
    [specId],
  );
  return rows
    .sort((a, b) =>
      mergeOrder(
        { role: a.role, id: a.repo_id },
        { role: b.role, id: b.repo_id },
      ),
    )
    .map((row, index) => ({
      order: index + 1,
      repo: row.role,
      number: row.number,
      url: row.url,
      state: row.state,
      draft: row.draft,
      ci: row.ci,
      review: row.review,
      syncError: row.sync_error ?? null,
    }));
}

interface TestCaseRow {
  name: string;
  classname: string;
  status: "passed" | "failed" | "skipped";
}

// A criterion is verified when every test the agent named for it is in the JUnit report of the integration
// branch's last gate and passed there. The agent may name a test as the report does, or as "classname name" or
// "classname.name", or only the last part of a nested "suite > test" name.
export function checkCriterion(
  tests: string[],
  cases: TestCaseRow[] | undefined,
): { status: "verified" | "unverified"; reason: string | null } {
  if (tests.length === 0)
    return { status: "unverified", reason: "the agent named no test" };
  if (!cases)
    return {
      status: "unverified",
      reason: "no JUnit results for the integration branch",
    };
  const problems: string[] = [];
  for (const test of tests) {
    const name = test.trim();
    const found = cases.filter(
      (c) =>
        c.name === name ||
        `${c.classname} ${c.name}` === name ||
        `${c.classname}.${c.name}` === name ||
        // vitest and jest report nested tests as "suite > test": the agent may name only the last part
        c.name.endsWith(` > ${name}`),
    );
    if (found.length === 0) problems.push(`not in the JUnit report: ${name}`);
    else if (found.some((c) => c.status === "failed"))
      problems.push(`failed: ${name}`);
    else if (found.every((c) => c.status === "skipped"))
      problems.push(`skipped: ${name}`);
  }
  return problems.length === 0
    ? { status: "verified", reason: null }
    : { status: "unverified", reason: problems.join("; ") };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export async function buildAcceptancePack(
  client: pg.PoolClient,
  specId: number,
  now: Date,
): Promise<AcceptancePack> {
  // the gate of each repo's integration branch as it was at the last merge
  const gateRows = await client.query<{
    repo_id: number;
    role: string;
    commit_sha: string;
    tests_total: number | null;
    tests_skipped: number | null;
    command_results: unknown;
    test_cases: TestCaseRow[] | null;
  }>(
    `SELECT DISTINCT ON (r.repo_id) r.repo_id, rp.role, g.commit_sha, g.tests_total, g.tests_skipped,
            g.command_results, g.test_cases
     FROM runs r JOIN repos rp ON rp.id = r.repo_id
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha
     WHERE r.spec_id = $1 AND r.stage IN ('merge', 'final-merge') AND r.result = 'merged'
     ORDER BY r.repo_id, r.id DESC`,
    [specId],
  );
  const casesOf = new Map(gateRows.rows.map((g) => [g.repo_id, g.test_cases]));

  const tickets = await client.query<{
    id: number;
    repo_id: number;
    title: string;
    acceptance_criteria: string[];
    allowed_protected_paths: string[];
  }>(
    `SELECT id, repo_id, title, acceptance_criteria, allowed_protected_paths FROM tickets
     WHERE spec_id = $1 AND state = 'done' ORDER BY id`,
    [specId],
  );
  const uncertainties: AcceptancePack["uncertainties"] = [];
  const ticketRows: AcceptancePack["tickets"] = [];
  for (const ticket of tickets.rows) {
    const display = formatDisplayId("ticket", ticket.id);
    const implement = await client.query<{ output: unknown }>(
      `SELECT output FROM runs WHERE ticket_id = $1 AND stage = 'implement' AND result = 'done'
       ORDER BY id DESC LIMIT 1`,
      [ticket.id],
    );
    const output = record(implement.rows[0]?.output);
    const named = record(output.acceptance);
    for (const text of strings(output.uncertainties))
      uncertainties.push({ source: `${display} implement`, text });
    const review = await client.query<{ output: unknown }>(
      "SELECT output FROM runs WHERE ticket_id = $1 AND stage = 'review' ORDER BY id DESC LIMIT 1",
      [ticket.id],
    );
    for (const text of strings(record(review.rows[0]?.output).uncertainties))
      uncertainties.push({ source: `${display} review`, text });
    ticketRows.push({
      displayId: display,
      title: ticket.title,
      criteria: ticket.acceptance_criteria.map((text) => {
        const tests = strings(named[text.trim()] ?? named[text]);
        return {
          text,
          tests,
          ...checkCriterion(tests, casesOf.get(ticket.repo_id) ?? undefined),
        };
      }),
    });
  }
  const finalReviews = await client.query<{ output: unknown }>(
    "SELECT output FROM runs WHERE spec_id = $1 AND ticket_id IS NULL AND stage = 'final-review' ORDER BY id",
    [specId],
  );
  for (const row of finalReviews.rows)
    for (const text of strings(record(row.output).uncertainties))
      uncertainties.push({
        source: `${formatDisplayId("spec", specId)} final review`,
        text,
      });

  const findings = await client.query<{
    ticket_id: number | null;
    run_id: number;
    stage: string;
    kind: string;
    body: string;
    resolution: string;
  }>(
    `SELECT r.ticket_id, r.id AS run_id, r.stage, f.kind, f.body, f.resolution
     FROM findings f JOIN runs r ON r.id = f.run_id WHERE r.spec_id = $1 ORDER BY f.id`,
    [specId],
  );
  const agent = await client.query<{ ms: string }>(
    "SELECT COALESCE(sum(duration_ms), 0) AS ms FROM runs WHERE spec_id = $1",
    [specId],
  );

  return {
    generatedAt: now.toISOString(),
    pullRequests: await pullRequestRows(client, specId),
    tickets: ticketRows,
    findings: findings.rows.map((f) => ({
      ticket:
        f.ticket_id === null ? null : formatDisplayId("ticket", f.ticket_id),
      run: formatDisplayId("run", f.run_id),
      stage: f.stage,
      kind: f.kind,
      body: f.body,
      resolution: f.resolution,
    })),
    uncertainties,
    gates: gateRows.rows.map((g) => {
      const steps = (Array.isArray(g.command_results) ? g.command_results : [])
        .map(record)
        .map((s) => ({
          name: String(s.name),
          exitCode: Number(s.exitCode),
          ms: Number(s.ms),
        }));
      return {
        repo: g.role,
        commitSha: g.commit_sha,
        testsTotal: g.tests_total,
        testsSkipped: g.tests_skipped,
        durationMs: steps.reduce((sum, s) => sum + s.ms, 0),
        steps,
      };
    }),
    protectedPathApprovals: tickets.rows
      .filter((t) => t.allowed_protected_paths.length > 0)
      .map((t) => ({
        ticket: formatDisplayId("ticket", t.id),
        paths: t.allowed_protected_paths,
      })),
    agentSeconds: Math.round(Number(agent.rows[0]?.ms) / 1000),
  };
}

export async function saveAcceptancePack(
  client: pg.PoolClient,
  specId: number,
  now: Date,
): Promise<void> {
  const pack = await buildAcceptancePack(client, specId, now);
  await client.query(
    `INSERT INTO acceptance_packs (spec_id, content) VALUES ($1, $2)
     ON CONFLICT (spec_id) DO UPDATE SET content = EXCLUDED.content, generated_at = now()`,
    [specId, JSON.stringify(pack)],
  );
}

// The stored pack with today's pull requests; null before one was made.
export async function readAcceptancePack(
  pool: Pick<pg.Pool, "query">,
  specId: number,
): Promise<AcceptancePack | null> {
  const { rows } = await pool.query<{ content: AcceptancePack }>(
    "SELECT content FROM acceptance_packs WHERE spec_id = $1",
    [specId],
  );
  if (!rows[0]) return null;
  return {
    ...rows[0].content,
    pullRequests: await pullRequestRows(pool, specId),
  };
}
