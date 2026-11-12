import {
  type AcceptancePackView,
  decisionTally,
  LOCATE_REASON_LABELS,
  MAX_INTEGRATION_ROUNDS,
  type PullRequestRowView,
  pauseReasonLabel,
  pullPhrase,
  type StageModels,
  type StructuredBrief,
  type TicketReviewMode,
} from "@afk/shared";

// Plain-text views for people. The JSON is the API's answer, untouched (--json); these only lay it out.

export function projectText(project: {
  id: number;
  name: string;
  defaultAgent: string | null;
  feishuChatId?: string | null;
  ticketReview?: TicketReviewMode;
  stageModels?: StageModels;
}): string {
  const lines = [`project ${project.id} ${project.name}`];
  if (project.defaultAgent !== null) {
    const inactive = project.defaultAgent === "cursor" ? "" : "（当前不生效）";
    lines.push(`default-agent: ${project.defaultAgent}${inactive}`);
  }
  if (project.feishuChatId) {
    lines.push(`feishu-chat: ${project.feishuChatId}`);
  }
  if (project.ticketReview) {
    lines.push(`ticket-review: ${project.ticketReview}`);
  }
  const stageModels = Object.entries(project.stageModels ?? {})
    .filter(([, model]) => model)
    .map(([role, model]) => `${role}=${model}`)
    .join(", ");
  if (stageModels) lines.push(`stage-models: ${stageModels}`);
  return lines.join("\n");
}

// One e2e of an integration ticket, with the diagnosis after it and the fix ticket that came of it.
interface AttemptLike {
  e2e: {
    displayId: string;
    result: string | null;
    testsTotal: number | null;
    testsFailed: number | null;
    envUpMs: number | null;
    refShas: Record<string, string> | null;
  };
  diagnosis: {
    failingRepo: string | null;
    evidence: string;
    failingTests: string[];
  } | null;
  fixTicket: { displayId: string; state: string; repo: string } | null;
}

interface BriefLike {
  run: { displayId: string };
  stage: string;
  result: string | null;
  output?: unknown;
  attempts?: AttemptLike[];
}

export function attemptLines(
  attempts: AttemptLike[],
  indent: string,
): string[] {
  return attempts.flatMap((attempt, i) => {
    const { e2e, diagnosis, fixTicket } = attempt;
    const counts =
      e2e.testsTotal === null
        ? ""
        : `, ${e2e.testsFailed ?? 0} of ${e2e.testsTotal} tests failed`;
    const env =
      e2e.envUpMs === null
        ? ""
        : `, environment up in ${(e2e.envUpMs / 1000).toFixed(1)} s`;
    const shas = Object.entries(e2e.refShas ?? {})
      .map(([name, sha]) => `${name}@${sha.slice(0, 8)}`)
      .join(", ");
    return [
      `${indent}e2e ${i + 1}: ${e2e.result ?? "running"} in ${e2e.displayId}${counts}${env}${shas ? `, built from ${shas}` : ""}`,
      ...(diagnosis
        ? [
            `${indent}  diagnosis: ${diagnosis.failingRepo ?? "no repo"}: ${diagnosis.evidence.split("\n")[0] ?? ""}`,
            ...(diagnosis.failingTests.length
              ? [`${indent}  failing: ${diagnosis.failingTests.join(", ")}`]
              : []),
          ]
        : []),
      ...(fixTicket
        ? [
            `${indent}  fix ticket: ${fixTicket.displayId} (${fixTicket.state}, ${fixTicket.repo})`,
          ]
        : []),
    ];
  });
}

const detailOf = (output: unknown): string => {
  if (typeof output !== "object" || output === null) return "";
  const o = output as {
    detail?: unknown;
    failureLog?: unknown;
    reasons?: unknown;
    unapproved?: unknown;
    error?: unknown;
  };
  if (typeof o.detail === "string") return o.detail;
  if (Array.isArray(o.unapproved))
    return `protected paths: ${o.unapproved.join(", ")}`;
  if (Array.isArray(o.reasons) && o.reasons.length > 0)
    return o.reasons.join("; ");
  if (typeof o.error === "string") return o.error;
  if (typeof o.failureLog === "string")
    return o.failureLog.split("\n").slice(0, 3).join(" ");
  return "";
};

export function briefLines(
  brief: BriefLike | null | undefined,
  indent = "  ",
): string[] {
  if (!brief) return [];
  const detail = detailOf(brief.output);
  return [
    `${indent}${brief.stage} ended ${brief.result ?? "?"} in ${brief.run.displayId}${detail ? `: ${detail}` : ""}`,
    `${indent}log: plat run logs ${brief.run.displayId}`,
    ...(brief.attempts?.length
      ? [`${indent}e2e tries:`, ...attemptLines(brief.attempts, `${indent}  `)]
      : []),
  ];
}

interface BlockingLike {
  downstream: string[];
  finalization: boolean;
  pullRequests: boolean;
  spec: boolean;
  merge: boolean;
}

interface TicketLike {
  id?: number;
  displayId: string;
  specDisplayId: string;
  title: string;
  state: string;
  blockedReason: string | null;
  repo: string;
  refs: string[];
  environment: string[];
  appended: boolean;
  brief: BriefLike | null;
  structuredBrief?: StructuredBrief | null;
  waitingSince?: string;
  blocking?: BlockingLike;
}

// The other repos a ticket reads (refs) and starts services of (environment), if it names any.
const contextLines = (
  t: Pick<TicketLike, "refs" | "environment">,
  indent: string,
) => [
  ...(t.refs.length ? [`${indent}refs: ${t.refs.join(", ")}`] : []),
  ...(t.environment.length
    ? [`${indent}environment: ${t.environment.join(", ")}`]
    : []),
];

const shortSha = (sha: string) => sha.slice(0, 8);

const shaList = (label: string, shas: Record<string, string> | null) =>
  shas
    ? `  ${label} ${Object.entries(shas)
        .map(([repo, sha]) => `${repo}@${shortSha(sha)}`)
        .join(", ")}`
    : "";

const stateOf = (t: Pick<TicketLike, "state" | "blockedReason">) =>
  t.blockedReason ? `${t.state} (${t.blockedReason})` : t.state;

interface FinalizationLike {
  id?: number;
  specDisplayId: string;
  repo: string;
  step: string;
  state: string;
  blockedReason: string | null;
  brief: BriefLike | null;
  structuredBrief?: StructuredBrief | null;
  waitingSince?: string;
  blocking?: BlockingLike;
}

const finalState = (f: FinalizationLike) =>
  `${f.step} ${f.state}${f.blockedReason ? ` (${f.blockedReason})` : ""}`;

// A pull request closed on the host without being merged says so, instead of just "closed".
const pullState = (state: string) =>
  state === "closed" ? "closed without merge" : state;

interface PullRequestProblemLike {
  specId?: number;
  specDisplayId: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  syncError: string | null;
  waitingSince?: string;
  blocking?: BlockingLike;
}

const pullRequestProblemLines = (p: PullRequestProblemLike): string[] => {
  const closed = p.state === "closed";
  const unreadable = p.syncError ? `could not be read: ${p.syncError}` : null;
  return [
    closed
      ? `${p.specDisplayId}  pull request ${p.repo} #${p.number} was ${pullState(p.state)}: ${p.url}`
      : `${p.specDisplayId}  pull request ${p.repo} #${p.number} ${unreadable}`,
    ...(closed && unreadable ? [`    ${unreadable}`] : []),
    ...(closed
      ? [
          `    reopen it, or rework the spec, or cancel it: plat spec cancel ${p.specDisplayId}`,
        ]
      : []),
  ];
};

type WaitingRef =
  | { kind: "ticket"; id: number }
  | { kind: "finalization"; id: number; step: string }
  | { kind: "pullRequest"; specId: number; repo: string; number: number }
  | { kind: "cleanup"; specId: number }
  | { kind: "readyFailure"; specId: number; repo: string; number: number }
  | { kind: "planning"; specId: number }
  | { kind: "pausedSpec"; id: number }
  | { kind: "locate"; specId: number };

interface CleanupLike {
  specId?: number;
  specDisplayId: string;
  error: string;
  waitingSince?: string;
  blocking?: BlockingLike;
}

interface ReadyFailureLike {
  specId?: number;
  specDisplayId: string;
  repo: string;
  number: number;
  error: string;
  waitingSince?: string;
  blocking?: BlockingLike;
}

interface PlanningLike {
  specId?: number;
  specDisplayId: string;
  repo: string;
  files: string[];
  waitingSince?: string;
  blocking?: BlockingLike;
}

interface PausedSpecLike {
  id?: number;
  displayId: string;
  title: string;
  reason: string;
  waitingSince?: string;
  blocking?: BlockingLike;
}

interface BlockedQueueLike {
  tickets: TicketLike[];
  finalizations: FinalizationLike[];
  pullRequests: PullRequestProblemLike[];
  cleanups: CleanupLike[];
  readyFailures: ReadyFailureLike[];
  planning: PlanningLike[];
  specs: PausedSpecLike[];
  locates?: LocateLike[];
  items?: WaitingRef[];
}

interface LocateLike {
  specId?: number;
  specDisplayId: string;
  title: string;
  reason: string;
  waitingSince?: string;
  blocking?: BlockingLike;
}

function rankOf(blocking: BlockingLike): number {
  if (blocking.downstream.length > 0) return 0;
  if (blocking.finalization || blocking.pullRequests) return 1;
  if (blocking.spec || blocking.merge) return 2;
  return 3;
}

function waitingLines(
  blocking?: BlockingLike,
  waitingSince?: string,
): string[] {
  if (!blocking) return [];
  const parts: string[] = [];
  if (blocking.downstream.length > 0)
    parts.push(`blocks ${blocking.downstream.join(", ")}`);
  if (blocking.finalization) parts.push("finalization cannot start");
  if (blocking.pullRequests) parts.push("blocks opening pull requests");
  if (blocking.spec) parts.push("blocks the whole spec");
  if (blocking.merge) parts.push("blocks merge to main");
  const blockingLine =
    parts.length > 0
      ? `    ${parts.join("; ")}`
      : "    does not block other tickets";
  if (!waitingSince) return [blockingLine];
  const rank = rankOf(blocking);
  const why =
    rank === 0
      ? `ranked first: it blocks unfinished downstream tickets, waiting since ${waitingSince}`
      : rank === 1
        ? `ranked here: it blocks finalization or opening pull requests, waiting since ${waitingSince}`
        : rank === 2
          ? `ranked here: it blocks the spec or merge to main, waiting since ${waitingSince}`
          : `ranked here: it does not block other work, waiting since ${waitingSince}`;
  return [blockingLine, `    ${why}`];
}

function structuredBriefLines(
  brief: StructuredBrief | null | undefined,
  indent = "    ",
): string[] {
  if (!brief) return [];
  return [
    `${indent}${brief.summary}`,
    `${indent}${brief.recommendedAction}`,
    ...brief.commands.map((item) => `${indent}${item.label}: ${item.command}`),
    ...(brief.ticketDraft
      ? brief.ticketDraft
          .replace(/\n+$/, "")
          .split("\n")
          .map((line) => `${indent}${line}`)
      : []),
  ];
}

function ticketLines(t: TicketLike): string[] {
  return [
    `${t.displayId}  ${t.specDisplayId}  ${stateOf(t)}  ${t.title}`,
    ...waitingLines(t.blocking, t.waitingSince),
    ...structuredBriefLines(t.structuredBrief),
    ...briefLines(t.brief, "    "),
  ];
}

function finalizationLines(f: FinalizationLike): string[] {
  return f.step === "final-e2e"
    ? [
        `${f.specDisplayId}  e2e before the pull requests: ${finalState(f)}`,
        ...waitingLines(f.blocking, f.waitingSince),
        ...structuredBriefLines(f.structuredBrief),
        ...briefLines(f.brief, "    "),
        `    then: plat spec retry-final ${f.specDisplayId} (run it again), or plat spec waive-final ${f.specDisplayId} (open the pull requests anyway; the acceptance pack will say the e2e failed)`,
      ]
    : [
        `${f.specDisplayId}  overall review of ${f.repo}: ${finalState(f)}`,
        ...waitingLines(f.blocking, f.waitingSince),
        ...structuredBriefLines(f.structuredBrief),
        ...briefLines(f.brief, "    "),
        `    then: plat spec retry-final ${f.specDisplayId}`,
      ];
}

function cleanupLines(c: CleanupLike): string[] {
  return [
    `${c.specDisplayId}  clean-up of the spec did not finish: ${c.error}`,
    ...waitingLines(c.blocking, c.waitingSince),
    `    branches or pull requests may be left on the code host; try again: plat spec cleanup ${c.specDisplayId}`,
  ];
}

function readyFailureLines(r: ReadyFailureLike): string[] {
  return [
    `${r.specDisplayId}  ${r.repo} #${r.number} could not be turned ready: ${r.error}`,
    ...waitingLines(r.blocking, r.waitingSince),
    "    it is still a draft; turn it ready on the code host once the pull requests it follows are merged",
  ];
}

function planningLines(p: PlanningLike): string[] {
  return [
    p.files.length > 0
      ? `${p.specDisplayId}  the planning docs did not apply to ${p.repo}'s default branch: ${p.files.join(", ")}`
      : `${p.specDisplayId}  the planning commit could not be made in ${p.repo}: its job failed three times (see the job's error)`,
    ...waitingLines(p.blocking, p.waitingSince),
    `    no ticket starts until: plat spec retry-planning ${p.specDisplayId} (in ${p.repo}, after pulling its default branch: it puts the docs back to merge, then sends them), or plat spec waive-planning ${p.specDisplayId} (leave them out)`,
  ];
}

function pausedSpecLines(s: PausedSpecLike): string[] {
  return [
    `${s.displayId}  paused  ${s.title}: ${pauseReasonLabel(s.reason)}`,
    ...waitingLines(s.blocking, s.waitingSince),
  ];
}

function locateReasonLabel(reason: string): string {
  return (LOCATE_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

function locateLines(item: LocateLike): string[] {
  return [
    `${item.specDisplayId}  locate  ${item.title}: ${locateReasonLabel(item.reason)}`,
    ...waitingLines(item.blocking, item.waitingSince),
    `    then: plat spec retry-locate ${item.specDisplayId} (run locate again), or plat spec create --type bug --source S-n after filling the original spec`,
  ];
}

function pullLines(p: PullRequestProblemLike): string[] {
  return [
    ...pullRequestProblemLines(p),
    ...waitingLines(p.blocking, p.waitingSince),
  ];
}

function linesFor(ref: WaitingRef, queue: BlockedQueueLike): string[] {
  if (ref.kind === "ticket") {
    const ticket = queue.tickets.find((item) => item.id === ref.id);
    return ticket ? ticketLines(ticket) : [];
  }
  if (ref.kind === "finalization") {
    const item = queue.finalizations.find(
      (row) => row.id === ref.id && row.step === ref.step,
    );
    return item ? finalizationLines(item) : [];
  }
  if (ref.kind === "pullRequest") {
    const item = queue.pullRequests.find(
      (row) =>
        row.specId === ref.specId &&
        row.repo === ref.repo &&
        row.number === ref.number,
    );
    return item ? pullLines(item) : [];
  }
  if (ref.kind === "cleanup") {
    const item = queue.cleanups.find((row) => row.specId === ref.specId);
    return item ? cleanupLines(item) : [];
  }
  if (ref.kind === "readyFailure") {
    const item = queue.readyFailures.find(
      (row) =>
        row.specId === ref.specId &&
        row.repo === ref.repo &&
        row.number === ref.number,
    );
    return item ? readyFailureLines(item) : [];
  }
  if (ref.kind === "planning") {
    const item = queue.planning.find((row) => row.specId === ref.specId);
    return item ? planningLines(item) : [];
  }
  if (ref.kind === "locate") {
    const item = (queue.locates ?? []).find((row) => row.specId === ref.specId);
    return item ? locateLines(item) : [];
  }
  const spec = queue.specs.find((row) => row.id === ref.id);
  return spec ? pausedSpecLines(spec) : [];
}

export function blockedText(queue: BlockedQueueLike): string {
  if (
    queue.tickets.length === 0 &&
    queue.finalizations.length === 0 &&
    queue.pullRequests.length === 0 &&
    queue.cleanups.length === 0 &&
    queue.readyFailures.length === 0 &&
    queue.planning.length === 0 &&
    queue.specs.length === 0 &&
    (queue.locates?.length ?? 0) === 0
  ) {
    return "nothing is waiting for you";
  }
  if (queue.items) {
    return queue.items.flatMap((ref) => linesFor(ref, queue)).join("\n");
  }
  return [
    ...queue.tickets.flatMap(ticketLines),
    ...queue.finalizations.flatMap(finalizationLines),
    ...queue.pullRequests.flatMap(pullLines),
    ...queue.cleanups.flatMap(cleanupLines),
    ...queue.readyFailures.flatMap(readyFailureLines),
    ...queue.planning.flatMap(planningLines),
    ...queue.specs.flatMap(pausedSpecLines),
    ...(queue.locates ?? []).flatMap(locateLines),
  ].join("\n");
}

export function ticketText(view: {
  ticket: TicketLike & {
    body: string;
    allowedProtectedPaths: string[];
    fixCounts: Record<string, number>;
    contentVersion: number;
  };
  versions: { version: number; createdAt: string }[];
  upstream: { displayId: string; kind: string; state: string }[];
  downstream: { displayId: string; kind: string; state: string }[];
  runs: {
    displayId: string;
    stage: string;
    attempt: number;
    result: string | null;
    durationMs: number | null;
    skillsSha: string | null;
    axis?: string | null;
    contractShas: Record<string, string> | null;
    refShas: Record<string, string> | null;
  }[];
  findings: {
    kind: string;
    body: string;
    resolution: string;
    axis?: string | null;
  }[];
  integration?: { rounds: number } | null;
}): string {
  const { ticket } = view;
  return [
    `${ticket.displayId}  ${stateOf(ticket)}  ${ticket.title}`,
    `spec ${ticket.specDisplayId}, repo ${ticket.repo}, version ${ticket.contentVersion}`,
    ...(view.versions.length > 1
      ? [
          `versions: ${view.versions.map((v) => v.version).join(", ")} (shown: ${ticket.contentVersion})`,
        ]
      : []),
    ...contextLines(ticket, ""),
    ...briefLines(ticket.brief),
    ...(view.integration
      ? [
          `integration: ${view.integration.rounds} of ${MAX_INTEGRATION_ROUNDS} fix rounds used`,
        ]
      : []),
    "",
    ticket.body.trimEnd(),
    "",
    ...(ticket.allowedProtectedPaths.length
      ? [`approved protected paths: ${ticket.allowedProtectedPaths.join(", ")}`]
      : []),
    ...(view.upstream.length
      ? [
          "waits for:",
          ...view.upstream.map(
            (e) => `  ${e.displayId} (${e.kind}, ${e.state})`,
          ),
        ]
      : []),
    ...(view.downstream.length
      ? [
          "blocks:",
          ...view.downstream.map(
            (e) => `  ${e.displayId} (${e.kind}, ${e.state})`,
          ),
        ]
      : []),
    "runs:",
    ...view.runs.map(
      (r) =>
        `  ${r.displayId}  ${r.stage}${r.axis ? ` (${r.axis})` : ""} #${r.attempt}  ${r.result ?? "running"}${r.durationMs === null ? "" : `  ${Math.round(r.durationMs / 1000)}s`}${r.skillsSha ? `  skills ${shortSha(r.skillsSha)}` : ""}${shaList("contracts", r.contractShas)}${shaList("refs", r.refShas)}`,
    ),
    ...(view.findings.length
      ? [
          "findings:",
          ...view.findings.map(
            (f) =>
              `  [${f.resolution}] ${f.axis ? `${f.axis} ` : ""}${f.kind}: ${f.body}`,
          ),
        ]
      : []),
  ].join("\n");
}

const pullRequestRow = (p: PullRequestRowView) =>
  `${p.order}. ${p.repo} #${p.number}  ${pullState(p.state)}${p.draft ? " (draft)" : ""}${p.waitsFor.length > 0 ? `  after ${p.waitsFor.join(", ")}` : ""}  ci ${p.ci}  review ${p.review}  ${p.url}${p.syncError ? `  [could not be read: ${p.syncError}]` : ""}`;

const brokenOrderLine = (b: { repo: string; skipped: string[] }) =>
  `merge order broken: ${b.repo} was merged before ${b.skipped.join(", ")}`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function decisionRows(
  items: {
    kind: string;
    source: string;
    run: string;
    text: string;
    ref?: string;
  }[],
): string[] {
  const tally = decisionTally(items);
  const rows = tally.listed.map((item) => {
    const ref = item.ref ? ` (${item.ref})` : "";
    return `      [${item.kind}] ${item.source} ${item.run}: ${item.text}${ref}`;
  });
  if (tally.choice > 0 || tally.workaround > 0) {
    rows.push(`      choice: ${tally.choice}, workaround: ${tally.workaround}`);
  }
  return rows;
}

// What a person reads before merging: the order to merge in, then a section for each repo (its pull request, which
// criteria are backed by a passing test, what the reviews said and the decisions agents made, its gate, and
// approved exceptions), and the tickets that were cancelled.
export function acceptancePackText(pack: AcceptancePackView): string {
  const order = pack.mergeOrder;
  const integration = pack.integration;
  const phrase = pullPhrase(pack.hostKind === "gitlab" ? "gitlab" : "github");
  return [
    "acceptance pack:",
    // what a person must not miss: the e2e before the pull requests failed and they were let through
    ...(integration?.failedBeforePullRequest
      ? [
          `  !! the e2e before the ${phrase}s failed; the ${phrase}s were opened anyway`,
          ...integration.failedBeforePullRequest.tickets.flatMap((t) => [
            `     ${t.displayId}  ${t.title}: ${t.e2e.displayId} ${t.e2e.result ?? "?"}`,
            ...(t.diagnosis
              ? [
                  `       diagnosis: ${t.diagnosis.failingRepo ?? "no repo"}: ${t.diagnosis.evidence}`,
                  ...(t.diagnosis.failingTests.length
                    ? [`       failing: ${t.diagnosis.failingTests.join(", ")}`]
                    : []),
                ]
              : []),
          ]),
        ]
      : []),
    ...(pack.planningDocs?.state === "waived"
      ? [
          `  !! the planning docs were left out: they did not apply to ${pack.planningDocs.repo}'s default branch and were given up`,
        ]
      : pack.planningDocs?.state === "committed"
        ? [
            `  planning docs: committed by the platform as the first commit of ${pack.planningDocs.repo}'s ${phrase}`,
          ]
        : []),
    ...pack.orderBroken.map((b) => `  ${brokenOrderLine(b)}`),
    order.ordered.length > 0
      ? `  merge order: ${order.ordered.join(" -> ")}${order.unordered.length ? `  (no order: ${order.unordered.join(", ")})` : ""}`
      : "  merge order: none (no contract relation between the repos)",
    ...pack.repos.flatMap((repo) => {
      const section = (title: string, lines: string[]) =>
        lines.length ? [`    ${title}:`, ...lines] : [];
      return [
        `  ${repo.repo}:`,
        ...(repo.pullRequest
          ? [`    ${phrase}: ${pullRequestRow(repo.pullRequest)}`]
          : [`    ${phrase}: none yet`]),
        ...section(
          "acceptance criteria",
          repo.tickets.flatMap((t) => [
            `      ${t.displayId}  ${t.title}${t.appended ? "  (appended)" : ""}`,
            ...t.criteria.map(
              (c) =>
                `        [${c.status}] ${c.text}${c.tests.length ? `  (${c.tests.join(", ")})` : ""}${c.reason ? `  -- ${c.reason}` : ""}`,
            ),
          ]),
        ),
        ...section(
          "findings",
          repo.findings.map(
            (f) =>
              `      [${f.resolution}] ${f.ticket ?? "spec"} ${f.stage}${f.axis ? ` (${f.axis})` : ""} ${f.kind}: ${f.body}`,
          ),
        ),
        ...section(
          "standards sources",
          (repo.standardsSources ?? []).map(
            (item) =>
              `      ${item.ticket ?? "spec"} ${item.run} ${item.stage}: ${item.sources.join(", ")}`,
          ),
        ),
        ...section(
          "scope creep (not asked for)",
          repo.scopeCreep.map(
            (s) => `      ${s.ticket ?? "spec"} ${s.run}: ${s.body}`,
          ),
        ),
        ...section("decisions", decisionRows(repo.decisions ?? [])),
        ...section(
          "gate",
          repo.gate
            ? [
                `      ${repo.repo} @ ${repo.gate.commitSha.slice(0, 8)}: ${repo.gate.testsTotal ?? "?"} tests, ${repo.gate.testsSkipped ?? "?"} skipped, ${seconds(repo.gate.durationMs)} (${repo.gate.steps.map((s) => `${s.name} ${seconds(s.ms)}${s.exitCode === 0 ? "" : ` exit ${s.exitCode}`}`).join(", ")})`,
              ]
            : [],
        ),
        ...section(
          "unstable tests (passed on rerun)",
          (repo.flakyTests ?? []).map((c) =>
            c.classname ? `      ${c.classname} ${c.name}` : `      ${c.name}`,
          ),
        ),
        ...section(
          "approved protected paths",
          repo.protectedPathApprovals.map(
            (a) => `      ${a.ticket}: ${a.paths.join(", ")}`,
          ),
        ),
      ];
    }),
    ...(integration
      ? [
          "  integration:",
          ...integration.tickets.flatMap((t) => [
            `    ${t.displayId}  ${t.title}  [${t.repo}]${t.appended ? "  (appended)" : ""}  e2e ${t.result ?? "did not run"}${t.runDisplayId ? ` in ${t.runDisplayId}` : ""}${t.testsTotal === null ? "" : `, ${t.testsFailed ?? 0} of ${t.testsTotal} tests failed`}${t.envUpMs === null ? "" : `, environment up in ${seconds(t.envUpMs)}`}`,
            ...(t.refShas && Object.keys(t.refShas).length
              ? [
                  `      environment: ${Object.entries(t.refShas)
                    .map(([name, sha]) => `${name}@${sha.slice(0, 8)}`)
                    .join(
                      ", ",
                    )}${t.headSha ? `, ${t.repo}@${t.headSha.slice(0, 8)}` : ""}`,
                ]
              : []),
            ...t.criteria.map(
              (c) =>
                `      [${c.status}] ${c.text}${c.tests.length ? `  (${c.tests.join(", ")})` : ""}${c.reason ? `  -- ${c.reason}` : ""}`,
            ),
          ]),
        ]
      : []),
    ...(pack.cancelledTickets.length
      ? [
          "  cancelled tickets:",
          ...pack.cancelledTickets.map(
            (t) => `    ${t.displayId}  ${t.title}  [${t.repo}]  (cancelled)`,
          ),
        ]
      : []),
    `  agent time: ${pack.agentSeconds} s`,
  ].join("\n");
}

export function specText(view: {
  spec: {
    displayId: string;
    title: string;
    body?: string;
    state: string;
    pauseReason: string | null;
    warnings: unknown[];
    planning?: {
      repo: string | null;
      state: string | null;
      sha: string | null;
      conflict: string[];
    };
    prechecks?: { code: string; level: string; message: string }[];
  };
  tickets: TicketLike[];
  finalizations: FinalizationLike[];
  edges: { from: string; to: string; kind: string }[];
  orderBroken?: { repo: string; skipped: string[] }[];
  pullRequests?: PullRequestRowView[];
  acceptancePack?: AcceptancePackView | null;
}): string {
  return [
    `${view.spec.displayId}  ${view.spec.state}  ${view.spec.title}`,
    ...(view.spec.pauseReason
      ? [`paused: ${pauseReasonLabel(view.spec.pauseReason)}`]
      : []),
    ...(view.spec.planning?.repo
      ? [
          `planning repo ${view.spec.planning.repo}: ${view.spec.planning.state ?? "not confirmed yet"}${view.spec.planning.sha ? ` at ${view.spec.planning.sha}` : ""}${view.spec.planning.conflict.length ? ` (did not apply: ${view.spec.planning.conflict.join(", ")})` : ""}`,
        ]
      : []),
    ...(view.spec.prechecks?.length
      ? view.spec.prechecks.map((p) => `yellow: ${p.message}`)
      : []),
    ...(view.spec.body?.trim() ? ["", view.spec.body.trimEnd(), ""] : []),
    "tickets:",
    ...view.tickets.flatMap((t) => [
      `  ${t.displayId}  ${stateOf(t)}  [${t.repo}]  ${t.title}${t.appended ? "  (appended)" : ""}`,
      ...contextLines(t, "      "),
      ...briefLines(t.brief, "      "),
    ]),
    ...(view.finalizations.length
      ? [
          "overall review:",
          ...view.finalizations.flatMap((f) => [
            `  ${f.repo}: ${finalState(f)}`,
            ...briefLines(f.brief, "    "),
          ]),
        ]
      : []),
    ...(view.acceptancePack
      ? []
      : (view.orderBroken ?? []).map(brokenOrderLine)),
    // the pack lists the pull requests itself; until it exists (some repos' are still being opened) they are shown here
    ...(view.acceptancePack
      ? [acceptancePackText(view.acceptancePack)]
      : view.pullRequests?.length
        ? [
            "pull requests:",
            ...view.pullRequests.map((p) => `  ${pullRequestRow(p)}`),
          ]
        : []),
    ...(view.edges.length
      ? [
          "edges:",
          ...view.edges.map((e) => `  ${e.from} -> ${e.to} (${e.kind})`),
        ]
      : []),
    ...(view.spec.warnings.length
      ? [
          "warnings:",
          ...view.spec.warnings.map(
            (w) =>
              `  ${(w as { message?: string }).message ?? JSON.stringify(w)}`,
          ),
        ]
      : []),
  ].join("\n");
}

export function contextText(data: {
  files: {
    path: string;
    specs: { displayId: string }[];
    tickets: { displayId: string }[];
    pullRequests: { number: number; url: string }[];
    decisions: { specDisplayId: string; heading: string }[];
    outOfScope: { specDisplayId: string; heading: string }[];
    adrs: { path: string }[];
  }[];
}): string {
  if (data.files.length === 0) return "no committed lines";
  return data.files
    .map((file) => {
      const lines = [file.path];
      const specs = file.specs.map((spec) => spec.displayId);
      if (specs.length) lines.push(`  specs: ${specs.join(", ")}`);
      const tickets = file.tickets.map((ticket) => ticket.displayId);
      if (tickets.length) lines.push(`  tickets: ${tickets.join(", ")}`);
      for (const pull of file.pullRequests) {
        lines.push(`  pull request: ${pull.url}`);
      }
      for (const decision of file.decisions) {
        lines.push(
          `  decisions: ${decision.specDisplayId} ${decision.heading}`,
        );
      }
      for (const scope of file.outOfScope) {
        lines.push(`  out of scope: ${scope.specDisplayId} ${scope.heading}`);
      }
      for (const adr of file.adrs) {
        lines.push(`  adr: ${adr.path}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
