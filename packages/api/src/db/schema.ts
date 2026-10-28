import {
  BLOCKED_REASONS,
  EDGE_KINDS,
  SPEC_STATES,
  SPEC_TYPES,
  TICKET_STATES,
  TICKET_TYPES,
} from "@afk/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Display ids (S-12, T-123, R-456) are the prefix plus the serial id; they are not stored.
// Field lists follow docs/design.md「领域模型与状态机」and docs/specs/m1-platform.md「数据模型」.

// CHECK constraint helper. The vocabularies come from @afk/shared so the database and zod cannot drift apart.
// The values are our own constants, never user input, so inlining them as literals is safe.
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  defaultAgent: text("default_agent"),
  defaultModel: text("default_model"),
  contractPath: text("contract_path"),
  protectedPaths: text("protected_paths").array().notNull().default([]),
  maxConcurrency: integer("max_concurrency"),
  budgetLimit: integer("budget_limit"),
  mergePolicy: text("merge_policy"),
  createdAt: createdAt(),
});

export const repos = pgTable(
  "repos",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("repos_project_idx").on(t.projectId)],
);

export const specs = pgTable(
  "specs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    state: text("state").notNull().default("draft"),
    sourceSpecId: integer("source_spec_id").references(
      (): AnyPgColumn => specs.id,
    ),
    integrationBranches: jsonb("integration_branches").notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index("specs_project_idx").on(t.projectId),
    check("specs_type_check", oneOf(t.type, SPEC_TYPES)),
    check("specs_state_check", oneOf(t.state, SPEC_STATES)),
  ],
);

export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria")
      .array()
      .notNull()
      .default([]),
    modules: text("modules").array().notNull().default([]),
    allowedProtectedPaths: text("allowed_protected_paths")
      .array()
      .notNull()
      .default([]),
    state: text("state").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    contentVersion: integer("content_version").notNull().default(1),
    contractSha: text("contract_sha"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tickets_spec_state_idx").on(t.specId, t.state),
    index("tickets_repo_idx").on(t.repoId),
    check("tickets_type_check", oneOf(t.type, TICKET_TYPES)),
    check("tickets_state_check", oneOf(t.state, TICKET_STATES)),
    // blocked <-> reason, as in TicketSchema
    check(
      "tickets_blocked_reason_check",
      sql`(${t.state} = 'blocked') = (${t.blockedReason} is not null) and (${t.blockedReason} is null or ${oneOf(t.blockedReason, BLOCKED_REASONS)})`,
    ),
  ],
);

export const edges = pgTable(
  "edges",
  {
    id: serial("id").primaryKey(),
    fromTicketId: integer("from_ticket_id")
      .notNull()
      .references(() => tickets.id),
    toTicketId: integer("to_ticket_id")
      .notNull()
      .references(() => tickets.id),
    kind: text("kind").notNull(),
  },
  (t) => [
    index("edges_to_ticket_idx").on(t.toTicketId),
    check("edges_kind_check", oneOf(t.kind, EDGE_KINDS)),
    unique("edges_from_to_kind_unique").on(
      t.fromTicketId,
      t.toTicketId,
      t.kind,
    ),
    check(
      "edges_no_self_dependency",
      sql`${t.fromTicketId} <> ${t.toTicketId}`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    state: text("state").notNull().default("queued"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0), // fencing token
    // One unique key per job. For ticket jobs the queue builds it from (ticket, content version, stage, sequence);
    // the format for jobs without a ticket (finalize, open-pr, host-sync) is the queue's to define (#23).
    idempotencyKey: text("idempotency_key").notNull().unique(),
    lockKey: text("lock_key"),
    requiredCapabilities: text("required_capabilities")
      .array()
      .notNull()
      .default([]),
    result: jsonb("result"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_state_lease_idx").on(t.state, t.leaseExpiresAt),
    index("jobs_lock_key_idx").on(t.lockKey),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    ticketId: integer("ticket_id").references(() => tickets.id),
    ticketVersion: integer("ticket_version"),
    jobId: integer("job_id").references(() => jobs.id),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull().default(1), // which try of this stage for this ticket; not the job fencing token
    agent: text("agent"),
    model: text("model"),
    skillsSha: text("skills_sha"),
    cursorCliVersion: text("cursor_cli_version"),
    branch: text("branch"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    commits: text("commits").array().notNull().default([]),
    durationMs: integer("duration_ms"),
    durationApiMs: integer("duration_api_ms"),
    tokenUsage: jsonb("token_usage"),
    result: text("result"),
    output: jsonb("output"),
    logUrl: text("log_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_ticket_idx").on(t.ticketId),
    index("runs_job_idx").on(t.jobId),
    index("runs_spec_idx").on(t.specId),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    resolution: text("resolution").notNull().default("unhandled"),
    createdAt: createdAt(),
  },
  (t) => [index("findings_run_idx").on(t.runId)],
);

export const gateResults = pgTable(
  "gate_results",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    commitSha: text("commit_sha").notNull(),
    configSha: text("config_sha").notNull(),
    commandResults: jsonb("command_results").notNull().default([]),
    testsTotal: integer("tests_total"),
    testsSkipped: integer("tests_skipped"),
    logUrl: text("log_url"),
    createdAt: createdAt(),
  },
  (t) => [unique("gate_results_repo_commit_unique").on(t.repoId, t.commitSha)],
);
