import {
  BLOCKED_REASONS,
  DISK_NOTICED,
  EDGE_KINDS,
  EVENT_SOURCES,
  EVENT_TYPES,
  FAILURE_SOURCES,
  FINAL_E2E_BLOCKED_REASONS,
  FINAL_STEPS,
  FINDING_RESOLUTIONS,
  HOST_KINDS,
  JOB_STATES,
  LINK_KINDS,
  LOCATE_REASONS,
  LOCATE_STATES,
  PAUSE_REASONS,
  SPEC_STATES,
  SPEC_TYPES,
  TICKET_REVIEW_MODES,
  TICKET_STATES,
  TICKET_TYPES,
} from "@afk/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Display ids (S-12, T-123, R-456) are the prefix plus the serial id; they are not stored.
// Field lists follow docs/design.md「领域模型与状态机」and docs/specs/m1-platform.md「数据模型」.

// CHECK constraint helper. The vocabularies come from @afk/shared so the database and zod cannot drift apart.
// The values are our own constants, never user input, so inlining them as literals is safe.
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    defaultAgent: text("default_agent"),
    defaultModel: text("default_model"),
    protectedPaths: text("protected_paths").array().notNull().default([]),
    maxConcurrency: integer("max_concurrency"),
    budgetLimit: integer("budget_limit"),
    mergePolicy: text("merge_policy"),
    // Overrides of DEFAULT_LIMITS in @afk/shared; anything not listed uses the default.
    limits: jsonb("limits").notNull().default({}),
    // When a worker last claimed a job of this project. Claim picks the project served longest ago so
    // projects take turns (packages/api/src/jobs/queue.ts). Null until the first claim.
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    // Feishu group chat_id for this project's notifications. Null until plat project edit --feishu-chat.
    feishuChatId: text("feishu_chat_id"),
    // Ticket-level review: Spec only (default) or both axes. final-review is always both (ADR 0002).
    ticketReview: text("ticket_review").notNull().default("spec"),
    // Per-role model overrides: standards, update-branch, merge-fix. Empty object: the default model.
    stageModels: jsonb("stage_models").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "projects_ticket_review_check",
      oneOf(t.ticketReview, TICKET_REVIEW_MODES),
    ),
  ],
);

export const repos = pgTable(
  "repos",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    // The default branch head last seen by host-sync; null until the first look.
    defaultSha: text("default_sha"),
    name: text("name").notNull(),
    // Where the repo keeps its contract file, if it owns one; null for a repo that has none.
    contractPath: text("contract_path"),
    // Which code host the repo is on: github or gitlab. It picks the seed template of the tracker doc.
    hostKind: text("host_kind").notNull().default("github"),
    // The last check of the bot's access to the repo, and when a new one was asked for (host/repo-access.ts).
    access: jsonb("access"),
    createdAt: createdAt(),
  },
  // The name (backend, frontend) is how a ticket file names a repo (its `repo` field), so it is unique within a project.
  (t) => [
    index("repos_project_idx").on(t.projectId),
    unique("repos_project_name_unique").on(t.projectId, t.name),
    check("repos_host_kind_check", oneOf(t.hostKind, HOST_KINDS)),
  ],
);

// One row, made by the migration that created it: the id of this database, which the branch names of every spec
// made from then on carry (packages/shared/src/branches.ts). Two databases working on one repository get two ids.
export const instance = pgTable(
  "instance",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: text("id").notNull(),
    // Last API log-retention sweep: when it ran and how many run directories / leftover run-* it deleted.
    logsPurgedAt: timestamp("logs_purged_at", { withTimezone: true }),
    logsPurgedRuns: integer("logs_purged_runs").notNull().default(0),
    logsPurgedOrphans: integer("logs_purged_orphans").notNull().default(0),
    // Last sampled size of the log dir and free bytes on that volume; disk_noticed is the last threshold we told.
    logDirBytes: bigint("log_dir_bytes", { mode: "number" })
      .notNull()
      .default(0),
    logDirFreeBytes: bigint("log_dir_free_bytes", { mode: "number" })
      .notNull()
      .default(0),
    diskNoticed: text("disk_noticed").notNull().default("none"),
    // Set while the agents' provider refuses work (out of usage, key refused): no agent job is claimed until they
    // are resumed. The reason is the error that paused them.
    agentsPausedAt: timestamp("agents_paused_at", { withTimezone: true }),
    agentsPauseReason: text("agents_pause_reason"),
    // A pause because the usage ran out hands out one agent job at this time to try the provider again (none for a
    // refused key); agents_probes counts the tries so far, agents_probe_job_id is the job of the last one.
    agentsProbeAt: timestamp("agents_probe_at", { withTimezone: true }),
    agentsProbes: integer("agents_probes").notNull().default(0),
    agentsProbeJobId: integer("agents_probe_job_id"),
    // Events through this id have been handed to the notice dispatcher; restart continues after it (ADR 0009).
    lastNotifiedEventId: bigint("last_notified_event_id", { mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [
    check("instance_singleton_check", sql`${t.singleton}`),
    check("instance_id_check", sql`${t.id} ~ '^[0-9a-f]{6}$'`),
    check("instance_disk_noticed_check", oneOf(t.diskNoticed, DISK_NOTICED)),
  ],
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
    // The database's id as it was when the spec was made; null for a spec older than that, whose branches have
    // the flat names.
    branchNamespace: text("branch_namespace"),
    // Warnings from the last tickets import (module overlap), shown when the plan is confirmed.
    importWarnings: jsonb("import_warnings").notNull().default([]),
    // Repos whose pull request was merged before the ones they wait for: [{ repo, skipped: [repo, ...] }]. Kept for
    // good once seen; it does not stop anything.
    orderBroken: jsonb("order_broken").notNull().default([]),
    // Why the platform paused the spec (PAUSE_REASONS); the waiting queue shows the Chinese label.
    pauseReason: text("pause_reason"),
    // SHAs a person has allowed Recheck to skip for wrap-up / update-branch. Only that commit.
    allowedRecheckShas: text("allowed_recheck_shas")
      .array()
      .notNull()
      .default([]),
    // Agent seconds a person has added on top of the project's limit when resuming a spec that ran out.
    budgetExtraSeconds: integer("budget_extra_seconds").notNull().default(0),
    // When the scheduler last started a ticket of the spec. Of two specs of a project holding as many slots, the one
    // that started a ticket longer ago (or never) gets the next free slot, so specs take turns.
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    // The planning repo, named when the spec was created there (`plat spec create` reads it from the tracker doc).
    planningRepoId: integer("planning_repo_id").references(() => repos.id),
    // The planning commit (GLOSSARY Planning commit): made by the platform once the spec is confirmed.
    planningSha: text("planning_sha"),
    // Where the planning commit is: pending (its job is queued or running), done, blocked (the docs patch did not
    // apply) or waived (a person gave the patch up). Null when the spec has no planning repo or is not confirmed.
    planningState: text("planning_state"),
    // The planning docs patch the CLI sent at confirm; dropped once the planning commit is made or waived.
    planningPatch: text("planning_patch"),
    // The files the patch did not apply to, when planning_state is blocked.
    planningConflict: jsonb("planning_conflict"),
    // The planning commit carries planning docs (it is not just the default branch's head): they need a pull
    // request even when the planning repo has no ticket of the spec.
    planningDocsCommitted: boolean("planning_docs_committed")
      .notNull()
      .default(false),
    // When this spec's run logs were deleted after the retention period; GET /runs/{id}/logs then says so.
    logsPurgedAt: timestamp("logs_purged_at", { withTimezone: true }),
    // Parked until the next final Run is claimed, then copied onto that Run and cleared.
    retryNote: text("retry_note"),
    // The platform token's user merged a pull request. Kept for good. A personal token that can push the
    // default branch is not flagged: that would mark every merge a person makes.
    tokenMerged: boolean("token_merged").notNull().default(false),
    // Filenames of planning-doc changes at the last tickets import (not the bodies). Page confirm names what it would drop.
    planningDocsAtImport: jsonb("planning_docs_at_import")
      .notNull()
      .default({ status: "unknown" }),
    // Locate of a bug draft: pending while the job is out, found after it filled the original spec,
    // failed when a person has to retry or fill the source by hand. Null on specs that never located.
    locateState: text("locate_state"),
    locateReason: text("locate_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("specs_project_idx").on(t.projectId),
    unique("specs_project_slug_unique").on(t.projectId, t.slug),
    unique("specs_id_project_unique").on(t.id, t.projectId),
    foreignKey({
      name: "specs_source_same_project_fk",
      columns: [t.sourceSpecId, t.projectId],
      foreignColumns: [t.id, t.projectId],
    }),
    check(
      "specs_source_bug_check",
      sql`${t.sourceSpecId} is null or ${t.type} = 'bug'`,
    ),
    check(
      "specs_source_not_self_check",
      sql`${t.sourceSpecId} is null or ${t.sourceSpecId} <> ${t.id}`,
    ),
    check("specs_type_check", oneOf(t.type, SPEC_TYPES)),
    check("specs_state_check", oneOf(t.state, SPEC_STATES)),
    check(
      "specs_planning_commit_check",
      sql`${t.planningSha} is null or ${t.planningRepoId} is not null`,
    ),
    check(
      "specs_planning_state_check",
      sql`${t.planningState} is null or ${t.planningState} in ('pending', 'done', 'blocked', 'waived')`,
    ),
    check(
      "specs_planning_sha_check",
      sql`${t.planningSha} is null or ${t.planningSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "specs_pause_reason_check",
      sql`(${t.state} = 'paused') = (${t.pauseReason} is not null) and (${t.pauseReason} is null or ${oneOf(t.pauseReason, PAUSE_REASONS)})`,
    ),
    check(
      "specs_locate_state_check",
      sql`${t.locateState} is null or ${oneOf(t.locateState, LOCATE_STATES)}`,
    ),
    check(
      "specs_locate_reason_check",
      sql`(${t.locateState} = 'failed') = (${t.locateReason} is not null) and (${t.locateReason} is null or ${oneOf(t.locateReason, LOCATE_REASONS)})`,
    ),
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
    // JUnit classname+name a person has allowed this ticket to drop. Empty until approve-removed-tests.
    allowedRemovedTests: jsonb("allowed_removed_tests")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // SHAs a person has allowed Recheck to skip for this ticket. Only that commit; a later hit still checks.
    allowedRecheckShas: text("allowed_recheck_shas")
      .array()
      .notNull()
      .default([]),
    // review-fix / merge-fix hit existing tests or config; the gate then enqueues Recheck.
    recheckPending: boolean("recheck_pending").notNull().default(false),
    // Names of repos: read-only references for the agent, and the repos an integration ticket's e2e environment starts.
    refs: text("refs").array().notNull().default([]),
    environment: text("environment").array().notNull().default([]),
    // User Story numbers in the spec this ticket is responsible for. Empty when omitted.
    stories: integer("stories").array().notNull().default([]),
    // Added to a spec that was already confirmed (plat tickets import --append).
    appended: boolean("appended").notNull().default(false),
    state: text("state").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    contentVersion: integer("content_version").notNull().default(1),
    // Pipeline progress (shared Progress): each fix kind is spent at most once, review runs once.
    fixCounts: jsonb("fix_counts")
      .notNull()
      .default({ "gate-fix": 0, "review-fix": 0, "merge-fix": 0 }),
    reviewed: boolean("reviewed").notNull().default(false),
    // Set by a restart-retry: the next implement run starts from the integration branch, not from the old branch.
    restart: boolean("restart").notNull().default(false),
    // Jobs up to this id were made before the last human retry: their failures no longer count towards blocking.
    jobFloor: integer("job_floor").notNull().default(0),
    contractSha: text("contract_sha"),
    // An integration ticket: the e2e failures that were followed by a fix ticket (at most two, then it is blocked).
    integrationRounds: integer("integration_rounds").notNull().default(0),
    // Parked until the next Run is claimed, then copied onto that Run and cleared. Not ticket content.
    retryNote: text("retry_note"),
    // Where a pending ticket starts: null is the beginning (implement); "e2e" for a ticket that is merged already.
    resumeStage: text("resume_stage"),
    // Tip of the ticket branch the platform last pushed. host-sync compares the remote SHA to this; null means do not compare.
    lastPushedSha: text("last_pushed_sha"),
    // After handback the next job resolves the resume stage from the remote tip before normal work continues.
    handbackPending: boolean("handback_pending").notNull().default(false),
    // A fix ticket the platform made for a failed e2e: the integration ticket it is for, and the round of it. One
    // fix ticket per round, so a diagnosis that is handed in twice makes no second one.
    fixForTicketId: integer("fix_for_ticket_id").references(
      (): AnyPgColumn => tickets.id,
    ),
    fixRound: integer("fix_round"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tickets_spec_state_idx").on(t.specId, t.state),
    index("tickets_repo_idx").on(t.repoId),
    uniqueIndex("tickets_fix_round_unique")
      .on(t.fixForTicketId, t.fixRound)
      .where(sql`${t.fixForTicketId} is not null`),
    check(
      "tickets_resume_stage_check",
      sql`${t.resumeStage} is null or ${t.resumeStage} in ('e2e', 'gate')`,
    ),
    check("tickets_type_check", oneOf(t.type, TICKET_TYPES)),
    check("tickets_state_check", oneOf(t.state, TICKET_STATES)),
    // blocked <-> reason, as in TicketSchema
    check(
      "tickets_blocked_reason_check",
      sql`(${t.state} = 'blocked') = (${t.blockedReason} is not null) and (${t.blockedReason} is null or ${oneOf(t.blockedReason, BLOCKED_REASONS)})`,
    ),
  ],
);

// The content of a ticket at each version, kept whole: an edit does not overwrite what a run was given.
export const ticketVersions = pgTable(
  "ticket_versions",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => tickets.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    acceptanceCriteria: text("acceptance_criteria").array().notNull(),
    modules: text("modules").array().notNull(),
    allowedProtectedPaths: text("allowed_protected_paths").array().notNull(),
    allowedRemovedTests: jsonb("allowed_removed_tests")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ticket_versions_ticket_version_unique").on(t.ticketId, t.version),
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
    attempt: integer("attempt").notNull().default(1), // fencing token; the first lease is attempt 1
    // One unique key per job. For ticket jobs the queue builds it from (ticket, content version, stage, sequence);
    // the format for jobs without a ticket (finalize, open-pr, host-sync) is the queue's to define (#23).
    // host-sync is one key per project: the same row is put back in the queue after each look.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    lockKey: text("lock_key"),
    // A queued job is not claimed before this time (host-sync runs a minute after the last one).
    notBefore: timestamp("not_before", { withTimezone: true }),
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
    check("jobs_state_check", oneOf(t.state, JOB_STATES)),
  ],
);

// The overall review of one repo's integration branch once all tickets of the spec are done.
export const finalizations = pgTable(
  "finalizations",
  {
    id: serial("id").primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    // the step whose job is out (or that failed, when blocked); done when the branch is settled
    step: text("step").notNull().default("final-review"),
    state: text("state").notNull().default("active"),
    blockedReason: text("blocked_reason"),
    jobFloor: integer("job_floor").notNull().default(0), // as on tickets
    createdAt: createdAt(),
  },
  (t) => [
    unique("finalizations_spec_repo_unique").on(t.specId, t.repoId),
    check("finalizations_step_check", oneOf(t.step, FINAL_STEPS)),
    check(
      "finalizations_state_check",
      oneOf(t.state, ["active", "blocked", "done"]),
    ),
    check(
      "finalizations_blocked_reason_check",
      sql`(${t.state} = 'blocked') = (${t.blockedReason} is not null)`,
    ),
    check(
      "finalizations_blocked_reason_code_check",
      sql`${t.blockedReason} is null or ${oneOf(t.blockedReason, BLOCKED_REASONS)}`,
    ),
  ],
);

// The e2e of every integration ticket, run once more before the pull requests are opened when a repo's final fix
// changed its branch (docs/specs/m2-platform.md「收尾、PR 与合并」). One per spec; it belongs to no ticket.
export const finalE2e = pgTable(
  "final_e2e",
  {
    id: serial("id").primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    // active: jobs are out; blocked: a person decides (retry, or let it through); done: every e2e passed; waived: a
    // person let the pull requests out although it failed
    state: text("state").notNull().default("active"),
    blockedReason: text("blocked_reason"),
    // which time it is run: a retry starts the next round, and a result of an earlier one changes nothing
    round: integer("round").notNull().default(1),
    // integration ticket id -> e2e | diagnosing | passed | failed, for the current round
    tickets: jsonb("tickets").notNull().default({}),
    jobFloor: integer("job_floor").notNull().default(0), // as on tickets
    createdAt: createdAt(),
  },
  (t) => [
    unique("final_e2e_spec_unique").on(t.specId),
    check(
      "final_e2e_state_check",
      oneOf(t.state, ["active", "blocked", "done", "waived"]),
    ),
    check(
      "final_e2e_blocked_reason_check",
      sql`(${t.state} = 'blocked') = (${t.blockedReason} is not null)`,
    ),
    check(
      "final_e2e_blocked_reason_code_check",
      sql`${t.blockedReason} is null or ${oneOf(t.blockedReason, FINAL_E2E_BLOCKED_REASONS)}`,
    ),
  ],
);

// A spec's pull request in one repo, as the code host last reported it (the platform records it, a person merges).
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: serial("id").primaryKey(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    state: text("state").notNull().default("open"),
    draft: boolean("draft").notNull().default(false),
    headSha: text("head_sha").notNull(),
    ci: text("ci").notNull().default("none"),
    review: text("review").notNull().default("none"),
    // Who the host says merged it, and when. The host's timestamp, not when the look ran.
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedBy: text("merged_by"),
    // Why the last look at the host failed for this pull request; cleared by the next one that works.
    syncError: text("sync_error"),
    // The host says this pull request conflicts with the default branch.
    conflictsWithDefault: boolean("conflicts_with_default")
      .notNull()
      .default(false),
    // The SHA the platform last pushed to this pull request's head branch. When host-sync records a
    // merge, the pull-request event stores whether the merged head is this SHA (docs/specs/m3-platform.md「成功标准」).
    platformHeadSha: text("platform_head_sha"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pull_requests_spec_repo_unique").on(t.specId, t.repoId),
    check(
      "pull_requests_state_check",
      oneOf(t.state, ["open", "closed", "merged"]),
    ),
    check(
      "pull_requests_ci_check",
      oneOf(t.ci, ["none", "pending", "success", "failure"]),
    ),
    check(
      "pull_requests_review_check",
      oneOf(t.review, ["none", "approved", "changes-requested"]),
    ),
  ],
);

// Two specs whose integration branches in one repo would conflict (docs/specs/m3-platform.md「trial-merge」).
// specIdA < specIdB so each pair has one row; overwritten on the next check.
export const potentialConflicts = pgTable(
  "potential_conflicts",
  {
    id: serial("id").primaryKey(),
    specIdA: integer("spec_id_a")
      .notNull()
      .references(() => specs.id),
    specIdB: integer("spec_id_b")
      .notNull()
      .references(() => specs.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    files: text("files").array().notNull(),
    shaA: text("sha_a").notNull(),
    shaB: text("sha_b").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("potential_conflicts_pair_unique").on(
      t.specIdA,
      t.specIdB,
      t.repoId,
    ),
    index("potential_conflicts_spec_a_idx").on(t.specIdA),
    index("potential_conflicts_spec_b_idx").on(t.specIdB),
    check(
      "potential_conflicts_ordered_check",
      sql`${t.specIdA} < ${t.specIdB}`,
    ),
    check("potential_conflicts_files_check", sql`cardinality(${t.files}) > 0`),
  ],
);

// The acceptance pack of a spec, made when its pull requests are all open (see acceptance/pack.ts).
export const acceptancePacks = pgTable("acceptance_packs", {
  id: serial("id").primaryKey(),
  specId: integer("spec_id")
    .notNull()
    .unique()
    .references(() => specs.id),
  content: jsonb("content").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    // Which axis of a review this Run reviewed (standards | spec); null for every other Run
    axis: text("axis"),
    // The standards-source files a Standards review used; null on every other Run
    sources: text("sources").array(),
    prompt: text("prompt"), // the whole prompt the agent was given: the overlay and the stage's own
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
    // The Retry note this Run was given, if any; null when the retry had none.
    retryNote: text("retry_note"),
    // The contract SHA used for each providing repo (name -> sha); null when the ticket had no contract edge.
    contractShas: jsonb("contract_shas"),
    // The SHA of the snapshot of each repo the ticket refs that the worker mounted at /refs/<name> (name -> sha).
    refShas: jsonb("ref_shas"),
    // An e2e Run's JUnit counts, and how long its integration environment took to come up.
    testsTotal: integer("tests_total"),
    testsFailed: integer("tests_failed"),
    envUpMs: integer("env_up_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_ticket_idx").on(t.ticketId),
    // One Run per job: it starts when the job is claimed and is filled in when the result arrives.
    unique("runs_job_unique").on(t.jobId),
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
  (t) => [
    index("findings_run_idx").on(t.runId),
    check(
      "findings_resolution_check",
      oneOf(t.resolution, FINDING_RESOLUTIONS),
    ),
  ],
);

export const gateResults = pgTable(
  "gate_results",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    commitSha: text("commit_sha").notNull(),
    // 'gate': the repo's own checks; 'e2e': an integration ticket's e2e in the integration environment. The same
    // commit has one of each.
    kind: text("kind").notNull().default("gate"),
    configSha: text("config_sha").notNull(),
    // What the result depends on: the tree gated and the gates.yaml blob it ran by. A pass is reused for the same pair.
    treeSha: text("tree_sha"),
    configBlob: text("config_blob"),
    commandResults: jsonb("command_results").notNull().default([]),
    testsTotal: integer("tests_total"),
    testsSkipped: integer("tests_skipped"),
    // Every case of the JUnit report ({ name, classname, status }); the acceptance pack checks criteria against it.
    testCases: jsonb("test_cases"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("gate_results_repo_commit_kind_unique").on(
      t.repoId,
      t.commitSha,
      t.kind,
    ),
    index("gate_results_tree_idx").on(t.repoId, t.treeSha, t.configBlob),
    check("gate_results_kind_check", oneOf(t.kind, ["gate", "e2e"])),
  ],
);

// One state change or a person's action (GLOSSARY Event), only appended. Written by database triggers in the same
// transaction as the change (drizzle/0035_events.sql); who made it comes from events/origin.ts. Read by the metrics.
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    specId: integer("spec_id"),
    ticketId: integer("ticket_id"),
    runId: integer("run_id"),
    jobId: integer("job_id"),
    repoId: integer("repo_id"),
    type: text("type").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    reason: text("reason"),
    source: text("source"),
    failureSource: text("failure_source"),
    data: jsonb("data").notNull().default({}),
  },
  (t) => [
    index("events_spec_idx").on(t.specId, t.id),
    index("events_ticket_idx").on(t.ticketId, t.id),
    index("events_at_idx").on(t.at),
    check("events_type_check", oneOf(t.type, EVENT_TYPES)),
    check(
      "events_source_check",
      sql`${t.source} is null or ${oneOf(t.source, EVENT_SOURCES)}`,
    ),
    check(
      "events_failure_source_check",
      sql`${t.failureSource} is null or ${oneOf(t.failureSource, FAILURE_SOURCES)}`,
    ),
  ],
);

// The code hosts the workers have credentials for, as last reported (drizzle/0037_code_hosts.sql).
export const codeHosts = pgTable(
  "code_hosts",
  {
    host: text("host").primaryKey(),
    kind: text("kind").notNull(),
    workerId: text("worker_id").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    tokenExpiresAt: text("token_expires_at"),
    tokenExpiryNoticedAt: timestamp("token_expiry_noticed_at", {
      withTimezone: true,
    }),
  },
  (t) => [
    check("code_hosts_kind_check", oneOf(t.kind, HOST_KINDS)),
    check("code_hosts_host_check", sql`${t.host} = lower(${t.host})`),
    check(
      "code_hosts_token_expires_at_check",
      sql`${t.tokenExpiresAt} is null or ${t.tokenExpiresAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
  ],
);

// One row per worker: last cleanup it reported, for the workbench status area.
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  reportedAt: timestamp("reported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  cleanedSandboxLogs: integer("cleaned_sandbox_logs").notNull().default(0),
  cleanedSalvage: integer("cleaned_salvage").notNull().default(0),
  cleanedSnapshots: integer("cleaned_snapshots").notNull().default(0),
  // Free bytes on the worker's home volume, last time it posted /worker/status.
  freeBytes: bigint("free_bytes", { mode: "number" }),
});

// Commit ↔ Ticket / Spec / PR (GLOSSARY Link). ticket kind is written when a ticket or wrap-up fix
// merges into the integration branch, from the rewritten SHAs the run recorded. pr kind is written
// when host-sync first sees a pull request merged, from trailers on the default branch (squash: Spec
// from the pull request body, no Ticket).
export const links = pgTable(
  "links",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    commitSha: text("commit_sha").notNull(),
    specId: integer("spec_id")
      .notNull()
      .references(() => specs.id),
    ticketId: integer("ticket_id").references(() => tickets.id),
    runId: integer("run_id").references(() => runs.id),
    pullRequestId: integer("pull_request_id").references(() => pullRequests.id),
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("links_repo_sha_kind_unique").on(t.repoId, t.commitSha, t.kind),
    index("links_spec_idx").on(t.specId),
    index("links_sha_idx").on(t.commitSha),
    check("links_kind_check", oneOf(t.kind, LINK_KINDS)),
    check("links_sha_check", sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
    check(
      "links_ticket_kind_run_check",
      sql`${t.kind} <> 'ticket' or ${t.runId} is not null`,
    ),
  ],
);

// Last `plat doctor` result for one planning machine of a project. GET returns the newest across machines.
export const doctorReports = pgTable(
  "doctor_reports",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    machine: text("machine").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    items: jsonb("items").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.machine] })],
);
