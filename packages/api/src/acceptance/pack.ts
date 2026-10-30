import { formatDisplayId } from "@afk/shared";
import { z } from "@hono/zod-openapi";
import type pg from "pg";
import { mergeOrderOf } from "../host/merge-order.ts";

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
  waitsFor: z.array(z.string()).default([]), // the repos whose pull requests come before this one
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

export const MergeOrderView = z.object({
  ordered: z.array(z.string()),
  after: z.record(z.string(), z.array(z.string())),
  unordered: z.array(z.string()),
});

export const OrderBroken = z.array(
  z.object({ repo: z.string(), skipped: z.array(z.string()) }),
);

const Gate = z.object({
  commitSha: z.string(),
  testsTotal: z.number().int().nullable(),
  testsSkipped: z.number().int().nullable(),
  durationMs: z.number().int(),
  steps: z.array(Step),
});

// What one repo of the spec brings to the decision: its pull request, the gate of its integration branch, the
// tickets done in it with each criterion's verdict, and what the agents and reviewers were unsure about.
const RepoSection = z.object({
  repo: z.string(),
  pullRequest: PullRequestRow.nullable(), // read live
  gate: Gate.nullable(),
  tickets: z.array(
    z.object({
      displayId: z.string(),
      title: z.string(),
      appended: z.boolean(), // added after the plan was confirmed
      criteria: z.array(
        z.object({
          text: z.string(),
          tests: z.array(z.string()), // what the agent named, in the last run that named any
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
  protectedPathApprovals: z.array(
    z.object({ ticket: z.string(), paths: z.array(z.string()) }),
  ),
});

// The pack of a spec (made once, when its pull requests are all open): the order to merge in, a section per repo,
// the tickets that were cancelled. The pull requests, the merge order and whether it was broken are read live.
// A section for the integration environment will join the repos when integration tickets bring their results; a
// spec without such tickets has none.
export const AcceptancePack = z.object({
  generatedAt: z.string(),
  mergeOrder: MergeOrderView,
  orderBroken: OrderBroken,
  repos: z.array(RepoSection),
  cancelledTickets: z.array(
    z.object({ displayId: z.string(), title: z.string(), repo: z.string() }),
  ),
  agentSeconds: z.number().int(),
});
export type AcceptancePack = z.infer<typeof AcceptancePack>;

// The pull requests in the order to merge them: the repos whose contracts others use come first, as the contract
// edges of the spec say (mergeOrderOf); a repo in no relation has no place in the order and follows.
export async function pullRequestRows(
  pool: Pick<pg.Pool, "query">,
  specId: number,
): Promise<PullRequestRow[]> {
  const { rows } = await pool.query(
    `SELECT r.id AS repo_id, r.name, p.number, p.url, p.state, p.draft, p.ci, p.review, p.sync_error
     FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.spec_id = $1`,
    [specId],
  );
  const merge = await mergeOrderOf(pool, specId);
  const place = (name: string) => {
    const at = merge.ordered.indexOf(name);
    return at === -1 ? merge.ordered.length : at;
  };
  return rows
    .sort((a, b) => place(a.name) - place(b.name) || a.repo_id - b.repo_id)
    .map((row, index) => ({
      order: index + 1,
      waitsFor: merge.after[row.name] ?? [],
      repo: row.name,
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

// Tests named for each criterion, from every implement and fix run of the ticket that finished: the last run to
// name a criterion decides. (A fix may add a test the implement run did not have.)
export function namedTests(outputs: readonly unknown[]): Map<string, string[]> {
  const named = new Map<string, string[]>();
  for (const output of outputs)
    for (const [text, tests] of Object.entries(
      record(record(output).acceptance),
    ))
      named.set(text.trim(), strings(tests));
  return named;
}

const AGENT_STAGES_WITH_TESTS = [
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
];

export async function buildAcceptancePack(
  client: Pick<pg.PoolClient, "query">,
  specId: number,
  now: Date,
): Promise<AcceptancePack> {
  // the gate of each repo's integration branch as it was at the last merge
  const gateRows = await client.query<{
    repo_id: number;
    commit_sha: string;
    tests_total: number | null;
    tests_skipped: number | null;
    command_results: unknown;
    test_cases: TestCaseRow[] | null;
  }>(
    `SELECT DISTINCT ON (r.repo_id) r.repo_id, g.commit_sha, g.tests_total, g.tests_skipped,
            g.command_results, g.test_cases
     FROM runs r
     JOIN gate_results g ON g.repo_id = r.repo_id AND g.commit_sha = r.head_sha AND g.kind = 'gate'
     WHERE r.spec_id = $1 AND r.stage IN ('merge', 'final-merge') AND r.result = 'merged'
     ORDER BY r.repo_id, r.id DESC`,
    [specId],
  );
  const casesOf = new Map(gateRows.rows.map((g) => [g.repo_id, g.test_cases]));

  const tickets = await client.query<{
    id: number;
    repo_id: number;
    repo: string;
    title: string;
    state: string;
    appended: boolean;
    acceptance_criteria: string[];
    allowed_protected_paths: string[];
  }>(
    `SELECT t.id, t.repo_id, r.name AS repo, t.title, t.state, t.appended, t.acceptance_criteria,
            t.allowed_protected_paths
     FROM tickets t JOIN repos r ON r.id = t.repo_id
     WHERE t.spec_id = $1 AND t.state IN ('done', 'cancelled') ORDER BY t.id`,
    [specId],
  );
  const sections = new Map<number, Section>();
  const sectionOf = (repoId: number, name: string): Section => {
    let section = sections.get(repoId);
    if (!section) {
      section = {
        repo: name,
        pullRequest: null,
        gate: null,
        tickets: [],
        findings: [],
        uncertainties: [],
        protectedPathApprovals: [],
      };
      sections.set(repoId, section);
    }
    return section;
  };
  const cancelledTickets: AcceptancePack["cancelledTickets"] = [];
  for (const ticket of tickets.rows) {
    const display = formatDisplayId("ticket", ticket.id);
    if (ticket.state === "cancelled") {
      cancelledTickets.push({
        displayId: display,
        title: ticket.title,
        repo: ticket.repo,
      });
      continue;
    }
    const section = sectionOf(ticket.repo_id, ticket.repo);
    const runs = await client.query<{ stage: string; output: unknown }>(
      `SELECT stage, output FROM runs
       WHERE ticket_id = $1 AND stage = ANY($2) AND result = 'done' ORDER BY id`,
      [ticket.id, AGENT_STAGES_WITH_TESTS],
    );
    const named = namedTests(runs.rows.map((r) => r.output));
    const lastImplement = runs.rows
      .filter((r) => r.stage === "implement")
      .at(-1);
    for (const text of strings(record(lastImplement?.output).uncertainties))
      section.uncertainties.push({ source: `${display} implement`, text });
    const review = await client.query<{ output: unknown }>(
      "SELECT output FROM runs WHERE ticket_id = $1 AND stage = 'review' ORDER BY id DESC LIMIT 1",
      [ticket.id],
    );
    for (const text of strings(record(review.rows[0]?.output).uncertainties))
      section.uncertainties.push({ source: `${display} review`, text });
    section.tickets.push({
      displayId: display,
      title: ticket.title,
      appended: ticket.appended,
      criteria: ticket.acceptance_criteria.map((text) => {
        const tests = named.get(text.trim()) ?? [];
        return {
          text,
          tests,
          ...checkCriterion(tests, casesOf.get(ticket.repo_id) ?? undefined),
        };
      }),
    });
    if (ticket.allowed_protected_paths.length > 0)
      section.protectedPathApprovals.push({
        ticket: display,
        paths: ticket.allowed_protected_paths,
      });
  }
  const finalReviews = await client.query<{
    repo_id: number;
    name: string;
    output: unknown;
  }>(
    `SELECT r.repo_id, rp.name, r.output FROM runs r JOIN repos rp ON rp.id = r.repo_id
     WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = 'final-review' ORDER BY r.id`,
    [specId],
  );
  for (const row of finalReviews.rows)
    for (const text of strings(record(row.output).uncertainties))
      sectionOf(row.repo_id, row.name).uncertainties.push({
        source: `${formatDisplayId("spec", specId)} final review`,
        text,
      });

  const findings = await client.query<{
    ticket_id: number | null;
    repo_id: number;
    repo: string;
    run_id: number;
    stage: string;
    kind: string;
    body: string;
    resolution: string;
  }>(
    `SELECT r.ticket_id, r.repo_id, rp.name AS repo, r.id AS run_id, r.stage, f.kind, f.body, f.resolution
     FROM findings f JOIN runs r ON r.id = f.run_id JOIN repos rp ON rp.id = r.repo_id
     WHERE r.spec_id = $1
       AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = r.ticket_id AND t.state = 'cancelled')
     ORDER BY f.id`,
    [specId],
  );
  for (const f of findings.rows)
    sectionOf(f.repo_id, f.repo).findings.push({
      ticket:
        f.ticket_id === null ? null : formatDisplayId("ticket", f.ticket_id),
      run: formatDisplayId("run", f.run_id),
      stage: f.stage,
      kind: f.kind,
      body: f.body,
      resolution: f.resolution,
    });

  for (const g of gateRows.rows) {
    const section = [...sections.entries()].find(
      ([id]) => id === g.repo_id,
    )?.[1];
    if (!section) continue;
    const steps = (Array.isArray(g.command_results) ? g.command_results : [])
      .map(record)
      .map((s) => ({
        name: String(s.name),
        exitCode: Number(s.exitCode),
        ms: Number(s.ms),
      }));
    section.gate = {
      commitSha: g.commit_sha,
      testsTotal: g.tests_total,
      testsSkipped: g.tests_skipped,
      durationMs: steps.reduce((sum, s) => sum + s.ms, 0),
      steps,
    };
  }

  const agent = await client.query<{ ms: string }>(
    "SELECT COALESCE(sum(duration_ms), 0) AS ms FROM runs WHERE spec_id = $1",
    [specId],
  );
  return withLiveFacts(client, specId, {
    generatedAt: now.toISOString(),
    mergeOrder: { ordered: [], after: {}, unordered: [] },
    orderBroken: [],
    repos: [...sections.values()],
    cancelledTickets,
    agentSeconds: Math.round(Number(agent.rows[0]?.ms) / 1000),
  });
}

type Section = AcceptancePack["repos"][number];

// What changes after the pack is made, and is read again each time it is shown: the pull requests, the merge
// order they follow, and whether a person broke it. The repo sections come out in merge order.
async function withLiveFacts(
  pool: Pick<pg.Pool, "query">,
  specId: number,
  pack: AcceptancePack,
): Promise<AcceptancePack> {
  const pulls = await pullRequestRows(pool, specId);
  const spec = await pool.query<{
    order_broken: { repo: string; skipped: string[] }[];
  }>("SELECT order_broken FROM specs WHERE id = $1", [specId]);
  const rank = (repo: string) =>
    pulls.find((p) => p.repo === repo)?.order ?? Number.MAX_SAFE_INTEGER;
  return {
    ...pack,
    mergeOrder: await mergeOrderOf(pool, specId),
    orderBroken: spec.rows[0]?.order_broken ?? [],
    repos: pack.repos
      .map((section) => ({
        ...section,
        pullRequest: pulls.find((p) => p.repo === section.repo) ?? null,
      }))
      .sort((a, b) => rank(a.repo) - rank(b.repo)),
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

// The stored pack with today's pull requests and merge order; null before one was made. A pack made before the
// packs were kept by repo (it has no repo sections) is made again from what the platform recorded, and kept.
export async function readAcceptancePack(
  pool: Pick<pg.Pool, "query">,
  specId: number,
): Promise<AcceptancePack | null> {
  const { rows } = await pool.query<{ content: AcceptancePack }>(
    "SELECT content FROM acceptance_packs WHERE spec_id = $1",
    [specId],
  );
  if (!rows[0]) return null;
  let pack = rows[0].content;
  if (!Array.isArray(pack.repos)) {
    pack = await buildAcceptancePack(pool, specId, new Date(pack.generatedAt));
    await pool.query(
      "UPDATE acceptance_packs SET content = $2 WHERE spec_id = $1",
      [specId, JSON.stringify(pack)],
    );
  }
  return withLiveFacts(pool, specId, pack);
}
