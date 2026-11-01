// AFK 平台 API 类型。形状与真实后端端点保持一致，mock 与真后端共用。

export type SpecState =
  | "draft"
  | "planned"
  | "running"
  | "finalizing"
  | "awaiting-review"
  | "partially-merged"
  | "reworking"
  | "merged"
  | "paused"
  | "cancelled";

export type TicketState = "pending" | "queued" | "running" | "merging" | "done" | "blocked" | "cancelled";
export type TicketType = "contract" | "implementation" | "integration" | "fix" | "system";
export type SpecType = "feature" | "bug" | "improvement";
export type EdgeKind = "blocks" | "contract";

export type BlockedReason =
  | "gate-failed"
  | "post-merge-gate-failed"
  | "merge-conflict"
  | "protected-path-changed"
  | "contract-copy-mismatch"
  | "no-commits"
  | "agent-gave-up"
  | "contract-change-needed"
  | "invalid-output"
  | "timeout"
  | "integration-loop-exceeded"
  | "integration-unknown-side"
  | "integration-environment-failed"
  | "upstream-cancelled"
  | "job-failed";

export type RunStage =
  | "implement"
  | "gate"
  | "review"
  | "merge"
  | "gate-fix"
  | "review-fix"
  | "merge-fix"
  | "e2e"
  | "diagnose";

export type FinalStep = "final-e2e" | "final-review" | "final-fix" | "final-merge";
export type FindingResolution = "unhandled" | "fixed" | "acceptance-pack";

export type PrState = "open" | "closed" | "merged";
export type PrCi = "none" | "pending" | "success" | "failure";
export type PrReview = "none" | "approved" | "changes-requested";
export type CriterionStatus = "verified" | "unverified";

export interface Progress {
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
  cancelled: number;
}

export interface Repo {
  name: string;
  contractPath: string | null;
  defaultBranch: string;
}

export interface SpecSummary {
  id: string;
  displayId: string;
  slug: string;
  title: string;
  type: SpecType;
  state: SpecState;
  pauseReason: string | null;
  project: string;
  progress: Progress;
}

export interface Spec extends SpecSummary {
  anomalyFrom?: SpecState | null;
  etaMinutes?: number | null;
  body: string;
  repos: Repo[];
  integrationBranch: string;
  createdAt: string;
  confirmedAt: string | null;
  deadlineAt: string | null;
  updatedAt: string;
}

export interface Ticket {
  id: string;
  displayId: string;
  specId: string;
  specDisplayId: string;
  repo: string;
  type: TicketType;
  state: TicketState;
  title: string;
  body: string;
  blockedReason: BlockedReason | null;
  blockedDetail: string | null;
  contentVersion: number;
  appended: boolean;
  branch: string;
  headSha: string | null;
  /** contract 票产出的契约 SHA；消费方等这个 SHA */
  contractSha: string | null;
  attempts: number;
  /** 受阻时：在哪个 Run 以什么结果结束 */
  blockedRun: BlockedRunRef | null;
  /** protected-path-changed 时未批准的保护路径 */
  protectedPaths: string[];
  approvedProtectedPaths: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  updatedAt: string;
}

export interface BlockedRunRef {
  id: string;
  displayId: string;
  stage: RunStage | FinalStep;
  state: "running" | "succeeded" | "failed" | "cancelled";
}

export interface Edge {
  /** 上游票 id */
  from: string;
  /** 下游票 id */
  to: string;
  kind: EdgeKind;
}

export type FinalizationState = "pending" | "running" | "done" | "blocked" | "waived";

export interface Finalization {
  id: string;
  specId: string;
  specDisplayId: string;
  step: FinalStep;
  /** final-review 等按仓库进行的步骤；final-e2e 为 null */
  repo: string | null;
  state: FinalizationState;
  blockedReason: BlockedReason | null;
  blockedDetail: string | null;
  runId: string | null;
  runDisplayId: string | null;
  updatedAt: string;
}

export interface PullRequest {
  id: string;
  specId: string;
  specDisplayId: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: PrState;
  draft: boolean;
  ci: PrCi;
  review: PrReview;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  mergedAt: string | null;
  /** 同步/读取 PR 失败时的错误 */
  syncError: string | null;
  waitsFor?: string[];
}

export interface MergeOrder {
  /** 按顺序必须先合的仓库 */
  ordered: string[];
  /** repo → 必须先合的仓库列表 */
  after: Record<string, string[]>;
  /** 没有顺序约束的仓库 */
  unordered: string[];
}

export interface OrderBroken {
  repo: string;
  skipped: string[];
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  status: CriterionStatus;
  reason: string | null;
  evidence: { ticketId: string; ticketDisplayId: string; test: string } | null;
}

export interface AcceptancePack {
  specId: string;
  generatedAt: string;
  summary: string;
  criteria: AcceptanceCriterion[];
  findings: Finding[];
  gate: { tests: number; skipped: number; durationMs: number; passed: boolean };
  risks: string[];
  repositories: AcceptanceRepository[];
}

export interface AcceptanceRepository {
  repo: string;
  criteria: (AcceptanceCriterion & { ticketId: string })[];
  findings: (Finding & { stage: RunStage | FinalStep; kind: FindingSource })[];
  uncertainties: { id: string; text: string; source: string; ticketId: string | null; runId: string | null }[];
  gates: { commitSha: string; tests: number; skipped: number; durationMs: number; steps: GateStep[] }[];
  approvedProtectedPaths: { ticketId: string; paths: string[] }[];
}

export interface TicketVersion {
  version: number;
  title: string;
  body: string;
  createdAt: string;
  author: string;
  acceptanceCriteria?: AcceptanceCriterion[];
}

export type RunState = "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: string;
  displayId: string;
  specId: string;
  ticketId: string | null;
  stage: RunStage | FinalStep;
  attempt: number;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  summary: string;
  model?: string | null;
  skillsSha?: string | null;
  contractRefs?: { repo: string; sha: string }[];
  refsSha?: string | null;
}

export type GateStepName = "setup" | "typecheck" | "test" | "lint" | "build";

export interface GateStep {
  name: GateStepName;
  exitCode: number | null;
  durationMs: number;
}

export interface GateResult {
  id: string;
  runId: string;
  ticketId: string;
  passed: boolean;
  tests: number;
  skipped: number;
  durationMs: number;
  steps: GateStep[];
  createdAt: string;
  commitSha?: string | null;
  hasJunit?: boolean;
}

export type FindingSource = "review" | "gate";
export type FindingSeverity = "blocker" | "major" | "minor";

export interface Finding {
  id: string;
  specId: string;
  ticketId: string | null;
  runId: string;
  source: FindingSource;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
  resolution: FindingResolution;
  axis?: "Standards" | "Spec";
  kind?: FindingSource;
}

export interface TicketRef {
  id: string;
  displayId: string;
  title: string;
  state: TicketState;
  repo: string;
  kind: EdgeKind;
}

export interface IntegrationInfo {
  loops: number;
  maxLoops: number;
  lastSide: "backend" | "frontend" | "unknown" | null;
  lastDiagnosis: string | null;
  fixTicketIds: string[];
  attempts: IntegrationAttempt[];
}

export interface IntegrationAttempt {
  runId: string;
  failedTests: number;
  totalTests: number;
  builds: { repo: string; sha: string }[];
  diagnosis: { repo: string | "unknown"; evidence: string; failedCases: string[] } | null;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface TicketBrief {
  runId: string;
  stage: RunStage | FinalStep;
  state: RunState;
  output: JsonValue;
}

export interface Cleanup {
  id: string;
  specId: string;
  specDisplayId: string;
  repo: string;
  kind: "branch" | "sandbox" | "worktree";
  target: string;
  error: string;
  createdAt: string;
}

export interface ReadyFailure {
  id: string;
  specId: string;
  specDisplayId: string;
  repo: string;
  step: string;
  error: string;
  createdAt: string;
}

/* ---------- 端点响应 ---------- */

export interface ListSpecsResponse {
  specs: SpecSummary[];
}

export interface SpecDetailResponse {
  timeline: SpecTimelineEvent[];
  spec: Spec;
  tickets: Ticket[];
  edges: Edge[];
  finalizations: Finalization[];
  pullRequests: PullRequest[];
  mergeOrder: MergeOrder;
  orderBroken: OrderBroken[];
  acceptancePack: AcceptancePack | null;
  importWarnings: ImportWarning[];
  runs: Run[];
  agentUsedSeconds: number;
}

export interface SpecTimelineEvent {
  type: string;
  at: string;
  title: string;
  detail?: string;
  href?: string;
}

export interface ImportWarning {
  id: string;
  message: string;
  ticketIds: string[];
  paths: string[];
}

export interface TicketDetailResponse {
  ticket: Ticket;
  versions: TicketVersion[];
  runs: Run[];
  findings: Finding[];
  gateResults: GateResult[];
  upstream: TicketRef[];
  downstream: TicketRef[];
  integration: IntegrationInfo | null;
  brief: TicketBrief | null;
  fixTickets: Ticket[];
}

export interface RunLogsResponse {
  attempt: number;
  offset: number;
  nextOffset: number;
  size: number;
  text: string;
  finished: boolean;
}

export interface RunDetailResponse {
  run: Run;
  ticket: Pick<Ticket, "id" | "displayId" | "title"> | null;
  spec: Pick<Spec, "id" | "displayId" | "title">;
  prompt: string;
  output: JsonValue;
  commits: { sha: string; message: string }[];
}

export interface BlockedResponse {
  tickets: Ticket[];
  finalizations: Finalization[];
  pullRequests: PullRequest[];
  cleanups: Cleanup[];
  readyFailures: ReadyFailure[];
  specs: SpecSummary[];
}

export type SearchMatch = "id" | "title" | "body";

export type SearchJump =
  | { kind: "spec"; id: string; displayId: string; title: string; state: SpecState }
  | { kind: "ticket"; id: string; displayId: string; title: string; state: TicketState; specDisplayId: string }
  | { kind: "run"; id: string; displayId: string; title: string; stage: RunStage | FinalStep; state: RunState; ticketId: string | null; specId: string; specDisplayId: string };

export interface SearchResponse {
  specs: (SpecSummary & { matched: SearchMatch[]; bodySnippet?: string })[];
  tickets: (Ticket & { matched: SearchMatch[] })[];
  jump?: SearchJump;
}

export interface RecentRun extends Run {
  ticketDisplayId: string | null;
  ticketTitle: string | null;
  specDisplayId: string;
  durationMs: number | null;
}

/** GET /runs/recent?limit= （mock 补充端点，真后端待定） */
export interface RecentRunsResponse {
  runs: RecentRun[];
}

export interface OkResponse {
  ok: true;
}

export type RetryMode = "continue" | "restart";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
