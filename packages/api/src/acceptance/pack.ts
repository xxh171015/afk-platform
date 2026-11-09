import {
  formatDisplayId,
  HOST_KINDS,
  type HostKind,
  REVIEW_AXES,
  type ReviewAxis,
} from "@afk/shared";
import { z } from "@hono/zod-openapi";
import type pg from "pg";
import { enqueuePackDescriptions } from "../host/host-jobs.ts";
import { mergeOrderOf } from "../host/merge-order.ts";
import { integrationAttempts } from "../tickets/integration-attempts.ts";

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
  hostKind: z.enum(HOST_KINDS).optional(),
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
      axis: z.enum(REVIEW_AXES).nullable(), // which axis of a review found it
    }),
  ),
  // The Spec axis's (b): behaviour nobody asked for, listed apart from the other findings.
  scopeCreep: z.array(
    z.object({
      ticket: z.string().nullable(),
      run: z.string(),
      body: z.string(),
    }),
  ),
  uncertainties: z.array(z.object({ source: z.string(), text: z.string() })),
  protectedPathApprovals: z.array(
    z.object({ ticket: z.string(), paths: z.array(z.string()) }),
  ),
});

// The integration tickets get a section of their own: the result of each one's last e2e (a rerun before the pull
// requests, if there was one, counts), which repos in the environment at which SHAs, and each criterion checked
// against that e2e's JUnit. When a person let the pull requests out although the e2e before them failed, it says so
// here with the evidence.
const IntegrationSection = z.object({
  failedBeforePullRequest: z
    .object({
      tickets: z.array(
        z.object({
          displayId: z.string(),
          title: z.string(),
          e2e: z.object({
            displayId: z.string(),
            result: z.string().nullable(),
          }),
          diagnosis: z
            .object({
              failingRepo: z.string().nullable(),
              evidence: z.string(),
              failingTests: z.array(z.string()),
            })
            .nullable(),
        }),
      ),
    })
    .nullable(),
  tickets: z.array(
    z.object({
      displayId: z.string(),
      title: z.string(),
      repo: z.string(),
      appended: z.boolean(),
      result: z.string().nullable(), // passed / failed, or null when no e2e ran
      runDisplayId: z.string().nullable(),
      testsTotal: z.number().int().nullable(),
      testsFailed: z.number().int().nullable(),
      envUpMs: z.number().int().nullable(),
      refShas: z.record(z.string(), z.string()).nullable(),
      headSha: z.string().nullable(),
      criteria: z.array(
        z.object({
          text: z.string(),
          tests: z.array(z.string()),
          status: z.enum(["verified", "unverified"]),
          reason: z.string().nullable(),
        }),
      ),
    }),
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
  hostKind: z.enum(HOST_KINDS).optional(),
  repos: z.array(RepoSection),
  integration: IntegrationSection.nullable().optional(), // none for a spec without integration tickets
  cancelledTickets: z.array(
    z.object({ displayId: z.string(), title: z.string(), repo: z.string() }),
  ),
  // the planning docs of the spec (ADR 0005), read live: committed onto the planning repo's integration branch,
  // none to commit, or given up by a person; null for a spec without a planning repo
  planningDocs: z
    .object({
      repo: z.string(),
      state: z.enum(["committed", "unchanged", "waived"]),
    })
    .nullable()
    .optional(),
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
    `SELECT r.id AS repo_id, r.name, p.number, p.url, p.state, p.draft, p.ci, p.review, p.sync_error, r.host_kind
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
      hostKind: row.host_kind as HostKind,
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
    type: string;
    repo_id: number;
    repo: string;
    title: string;
    state: string;
    appended: boolean;
    acceptance_criteria: string[];
    allowed_protected_paths: string[];
  }>(
    `SELECT t.id, t.type, t.repo_id, r.name AS repo, t.title, t.state, t.appended, t.acceptance_criteria,
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
        scopeCreep: [],
        uncertainties: [],
        protectedPathApprovals: [],
      };
      sections.set(repoId, section);
    }
    return section;
  };
  const cancelledTickets: AcceptancePack["cancelledTickets"] = [];
  // integration tickets are shown in their own section, with the tests the agent named for each criterion
  const integrationTickets: {
    ticket: (typeof tickets.rows)[number];
    named: Map<string, string[]>;
  }[] = [];
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
    // both axes of the newest review (a review made before there were axes has one Run without an axis)
    const review = await client.query<{ output: unknown }>(
      `SELECT DISTINCT ON (axis) output FROM runs
       WHERE ticket_id = $1 AND stage = 'review' AND output IS NOT NULL ORDER BY axis DESC, id DESC`,
      [ticket.id],
    );
    for (const row of review.rows)
      for (const text of strings(record(row.output).uncertainties))
        section.uncertainties.push({ source: `${display} review`, text });
    if (ticket.type === "integration") {
      integrationTickets.push({ ticket, named });
    } else {
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
    }
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
    `SELECT DISTINCT ON (r.repo_id, r.axis) r.repo_id, rp.name, r.output FROM runs r JOIN repos rp ON rp.id = r.repo_id
     WHERE r.spec_id = $1 AND r.ticket_id IS NULL AND r.stage = 'final-review' AND r.output IS NOT NULL
     ORDER BY r.repo_id, r.axis DESC, r.id DESC`,
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
    axis: ReviewAxis | null;
  }>(
    `SELECT r.ticket_id, r.repo_id, rp.name AS repo, r.id AS run_id, r.stage, r.axis, f.kind, f.body, f.resolution
     FROM findings f JOIN runs r ON r.id = f.run_id JOIN repos rp ON rp.id = r.repo_id
     WHERE r.spec_id = $1
       AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = r.ticket_id AND t.state = 'cancelled')
     ORDER BY f.id`,
    [specId],
  );
  for (const f of findings.rows) {
    const ticket =
      f.ticket_id === null ? null : formatDisplayId("ticket", f.ticket_id);
    const run = formatDisplayId("run", f.run_id);
    // scope creep has a list of its own in the pack: it is the part of a review a person has to look at
    if (f.kind === "scope-creep") {
      sectionOf(f.repo_id, f.repo).scopeCreep.push({
        ticket,
        run,
        body: f.body,
      });
      continue;
    }
    sectionOf(f.repo_id, f.repo).findings.push({
      ticket,
      run,
      stage: f.stage,
      kind: f.kind,
      body: f.body,
      resolution: f.resolution,
      axis: f.axis,
    });
  }

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
    integration: await integrationSection(client, specId, integrationTickets),
    cancelledTickets,
    agentSeconds: Math.round(Number(agent.rows[0]?.ms) / 1000),
  });
}

type Section = AcceptancePack["repos"][number];

async function integrationSection(
  client: Pick<pg.PoolClient, "query">,
  specId: number,
  found: {
    ticket: {
      id: number;
      repo_id: number;
      repo: string;
      title: string;
      appended: boolean;
      acceptance_criteria: string[];
    };
    named: Map<string, string[]>;
  }[],
): Promise<AcceptancePack["integration"]> {
  if (found.length === 0) return null;
  const waived = await client.query(
    "SELECT 1 FROM final_e2e WHERE spec_id = $1 AND state = 'waived'",
    [specId],
  );
  const failed: NonNullable<
    NonNullable<AcceptancePack["integration"]>["failedBeforePullRequest"]
  >["tickets"] = [];
  const tickets: NonNullable<AcceptancePack["integration"]>["tickets"] = [];
  for (const { ticket, named } of found) {
    const display = formatDisplayId("ticket", ticket.id);
    // the last e2e of the ticket decides: a rerun before the pull requests is the last one
    const last = (
      await client.query<{
        id: number;
        result: string | null;
        tests_total: number | null;
        tests_failed: number | null;
        env_up_ms: number | null;
        ref_shas: Record<string, string> | null;
        head_sha: string | null;
      }>(
        `SELECT id, result, tests_total, tests_failed, env_up_ms, ref_shas, head_sha FROM runs
         WHERE ticket_id = $1 AND stage = 'e2e' AND result IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [ticket.id],
      )
    ).rows[0];
    const gate = last?.head_sha
      ? (
          await client.query<{ test_cases: TestCaseRow[] | null }>(
            "SELECT test_cases FROM gate_results WHERE repo_id = $1 AND commit_sha = $2 AND kind = 'e2e'",
            [ticket.repo_id, last.head_sha],
          )
        ).rows[0]
      : undefined;
    tickets.push({
      displayId: display,
      title: ticket.title,
      repo: ticket.repo,
      appended: ticket.appended,
      result: last?.result ?? null,
      runDisplayId: last ? formatDisplayId("run", last.id) : null,
      testsTotal: last?.tests_total ?? null,
      testsFailed: last?.tests_failed ?? null,
      envUpMs: last?.env_up_ms ?? null,
      refShas: last?.ref_shas ?? null,
      headSha: last?.head_sha ?? null,
      criteria: ticket.acceptance_criteria.map((text) => {
        const tests = named.get(text.trim()) ?? [];
        // the e2e's own JUnit is what verifies an integration ticket, not the repo's unit gate
        return {
          text,
          tests,
          ...checkCriterion(
            tests,
            gate ? (gate.test_cases ?? undefined) : undefined,
          ),
        };
      }),
    });
    if (waived.rowCount && last?.result !== "passed") {
      const attempt = (await integrationAttempts(client, ticket.id)).at(-1);
      failed.push({
        displayId: display,
        title: ticket.title,
        e2e: {
          displayId: last ? formatDisplayId("run", last.id) : "",
          result: last?.result ?? null,
        },
        diagnosis: attempt?.diagnosis ?? null,
      });
    }
  }
  return {
    failedBeforePullRequest: waived.rowCount ? { tickets: failed } : null,
    tickets,
  };
}

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
    planning_state: string | null;
    planning_docs_committed: boolean;
    planning_repo: string | null;
    host_kind: HostKind | null;
  }>(
    `SELECT s.order_broken, s.planning_state, s.planning_docs_committed, r.name AS planning_repo,
            (SELECT repo.host_kind FROM repos repo WHERE repo.project_id = s.project_id ORDER BY repo.id LIMIT 1) AS host_kind
     FROM specs s LEFT JOIN repos r ON r.id = s.planning_repo_id WHERE s.id = $1`,
    [specId],
  );
  const planning = spec.rows[0];
  const rank = (repo: string) =>
    pulls.find((p) => p.repo === repo)?.order ?? Number.MAX_SAFE_INTEGER;
  return {
    ...pack,
    hostKind: planning?.host_kind ?? "github",
    mergeOrder: await mergeOrderOf(pool, specId),
    orderBroken: planning?.order_broken ?? [],
    planningDocs:
      planning?.planning_repo &&
      (planning.planning_state === "done" ||
        planning.planning_state === "waived")
        ? {
            repo: planning.planning_repo,
            state:
              planning.planning_state === "waived"
                ? "waived"
                : planning.planning_docs_committed
                  ? "committed"
                  : "unchanged",
          }
        : null,
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
  await enqueuePackDescriptions(client, specId);
}

// The stored pack with today's pull requests and merge order; null before one was made. A pack made before the
// packs were kept by repo (it has no repo sections) is made again from what the platform recorded, and kept.
const asArray = <T>(value: T[] | undefined | null): T[] =>
  Array.isArray(value) ? value : [];

function coerceStoredPack(raw: unknown): AcceptancePack | null {
  if (!raw || typeof raw !== "object") return null;
  const pack = raw as Record<string, unknown>;
  if (!Array.isArray(pack.repos)) return null;
  const mergeOrder =
    pack.mergeOrder && typeof pack.mergeOrder === "object"
      ? (pack.mergeOrder as Record<string, unknown>)
      : {};
  const candidate = {
    ...pack,
    generatedAt:
      typeof pack.generatedAt === "string"
        ? pack.generatedAt
        : new Date(0).toISOString(),
    agentSeconds: typeof pack.agentSeconds === "number" ? pack.agentSeconds : 0,
    integration: pack.integration ?? null,
    cancelledTickets: asArray(pack.cancelledTickets as never[]),
    orderBroken: asArray(pack.orderBroken as never[]),
    mergeOrder: {
      ordered: asArray(mergeOrder.ordered as string[]),
      after:
        mergeOrder.after && typeof mergeOrder.after === "object"
          ? mergeOrder.after
          : {},
      unordered: asArray(mergeOrder.unordered as string[]),
    },
    repos: pack.repos.map((section) => {
      const repo =
        section && typeof section === "object"
          ? (section as Record<string, unknown>)
          : {};
      return {
        ...repo,
        repo: typeof repo.repo === "string" ? repo.repo : "",
        pullRequest: repo.pullRequest ?? null,
        gate: repo.gate ?? null,
        tickets: asArray(repo.tickets as never[]).map((ticket) => {
          const row =
            ticket && typeof ticket === "object"
              ? (ticket as Record<string, unknown>)
              : {};
          return {
            ...row,
            criteria: asArray(row.criteria as never[]).map((criterion) => {
              const item =
                criterion && typeof criterion === "object"
                  ? (criterion as Record<string, unknown>)
                  : {};
              return { ...item, tests: asArray(item.tests as string[]) };
            }),
          };
        }),
        findings: asArray(repo.findings as never[]),
        scopeCreep: asArray(repo.scopeCreep as never[]),
        uncertainties: asArray(repo.uncertainties as never[]),
        protectedPathApprovals: asArray(repo.protectedPathApprovals as never[]),
      };
    }),
  };
  const parsed = AcceptancePack.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function readAcceptancePack(
  pool: Pick<pg.Pool, "query">,
  specId: number,
): Promise<AcceptancePack | null> {
  const { rows } = await pool.query<{ content: unknown }>(
    "SELECT content FROM acceptance_packs WHERE spec_id = $1",
    [specId],
  );
  if (!rows[0]) return null;
  const stored = rows[0].content;
  let pack = coerceStoredPack(stored);
  if (!pack) {
    const generatedAt =
      stored &&
      typeof stored === "object" &&
      typeof (stored as { generatedAt?: unknown }).generatedAt === "string"
        ? (stored as { generatedAt: string }).generatedAt
        : new Date().toISOString();
    pack = await buildAcceptancePack(pool, specId, new Date(generatedAt));
    await pool.query(
      "UPDATE acceptance_packs SET content = $2 WHERE spec_id = $1",
      [specId, JSON.stringify(pack)],
    );
  }
  return withLiveFacts(pool, specId, pack);
}
