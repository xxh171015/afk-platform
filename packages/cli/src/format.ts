import {
  type AcceptancePackView,
  MAX_INTEGRATION_ROUNDS,
  type PullRequestRowView,
} from "@afk/shared";

// Plain-text views for people. The JSON is the API's answer, untouched (--json); these only lay it out.

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

interface TicketLike {
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

const shaList = (label: string, shas: Record<string, string> | null) =>
  shas
    ? `  ${label} ${Object.entries(shas)
        .map(([repo, sha]) => `${repo}@${sha.slice(0, 8)}`)
        .join(", ")}`
    : "";

const stateOf = (t: Pick<TicketLike, "state" | "blockedReason">) =>
  t.blockedReason ? `${t.state} (${t.blockedReason})` : t.state;

interface FinalizationLike {
  specDisplayId: string;
  repo: string;
  step: string;
  state: string;
  blockedReason: string | null;
  brief: BriefLike | null;
}

const finalState = (f: FinalizationLike) =>
  `${f.step} ${f.state}${f.blockedReason ? ` (${f.blockedReason})` : ""}`;

// A pull request closed on the host without being merged says so, instead of just "closed".
const pullState = (state: string) =>
  state === "closed" ? "closed without merge" : state;

interface PullRequestProblemLike {
  specDisplayId: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  syncError: string | null;
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

export function blockedText(queue: {
  tickets: TicketLike[];
  finalizations: FinalizationLike[];
  pullRequests: PullRequestProblemLike[];
  cleanups: { specDisplayId: string; error: string }[];
  readyFailures: {
    specDisplayId: string;
    repo: string;
    number: number;
    error: string;
  }[];
  specs: { displayId: string; title: string; reason: string }[];
}): string {
  if (
    queue.tickets.length === 0 &&
    queue.finalizations.length === 0 &&
    queue.pullRequests.length === 0 &&
    queue.cleanups.length === 0 &&
    queue.readyFailures.length === 0 &&
    queue.specs.length === 0
  ) {
    return "nothing is waiting for you";
  }
  return [
    ...queue.tickets.flatMap((t) => [
      `${t.displayId}  ${t.specDisplayId}  ${stateOf(t)}  ${t.title}`,
      ...briefLines(t.brief, "    "),
    ]),
    ...queue.finalizations.flatMap((f) =>
      f.step === "final-e2e"
        ? [
            `${f.specDisplayId}  e2e before the pull requests: ${finalState(f)}`,
            ...briefLines(f.brief, "    "),
            `    then: plat spec retry-final ${f.specDisplayId} (run it again), or plat spec waive-final ${f.specDisplayId} (open the pull requests anyway; the acceptance pack will say the e2e failed)`,
          ]
        : [
            `${f.specDisplayId}  overall review of ${f.repo}: ${finalState(f)}`,
            ...briefLines(f.brief, "    "),
            `    then: plat spec retry-final ${f.specDisplayId}`,
          ],
    ),
    ...queue.pullRequests.flatMap(pullRequestProblemLines),
    ...queue.cleanups.flatMap((c) => [
      `${c.specDisplayId}  clean-up of the spec did not finish: ${c.error}`,
      `    branches or pull requests may be left on the code host; try again: plat spec cleanup ${c.specDisplayId}`,
    ]),
    ...queue.readyFailures.flatMap((r) => [
      `${r.specDisplayId}  ${r.repo} #${r.number} could not be turned ready: ${r.error}`,
      "    it is still a draft; turn it ready on the code host once the pull requests it follows are merged",
    ]),
    ...queue.specs.map(
      (s) => `${s.displayId}  paused  ${s.title}: ${s.reason}`,
    ),
  ].join("\n");
}

export function ticketText(view: {
  ticket: TicketLike & {
    acceptanceCriteria: string[];
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
    contractShas: Record<string, string> | null;
    refShas: Record<string, string> | null;
  }[];
  findings: { kind: string; body: string; resolution: string }[];
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
    "acceptance:",
    ...ticket.acceptanceCriteria.map((c) => `  - ${c}`),
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
        `  ${r.displayId}  ${r.stage} #${r.attempt}  ${r.result ?? "running"}${r.durationMs === null ? "" : `  ${Math.round(r.durationMs / 1000)}s`}${r.skillsSha ? `  skills ${r.skillsSha.slice(0, 8)}` : ""}${shaList("contracts", r.contractShas)}${shaList("refs", r.refShas)}`,
    ),
    ...(view.findings.length
      ? [
          "findings:",
          ...view.findings.map(
            (f) => `  [${f.resolution}] ${f.kind}: ${f.body}`,
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

// What a person reads before merging: the order to merge in, then a section for each repo (its pull request, which
// criteria are backed by a passing test, what the reviews said and what the agents were unsure of, its gate, and
// approved exceptions), and the tickets that were cancelled.
export function acceptancePackText(pack: AcceptancePackView): string {
  const order = pack.mergeOrder;
  const integration = pack.integration;
  return [
    "acceptance pack:",
    // what a person must not miss: the e2e before the pull requests failed and they were let through
    ...(integration?.failedBeforePullRequest
      ? [
          "  !! the e2e before the pull requests failed; the pull requests were opened anyway",
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
          ? [`    pull request: ${pullRequestRow(repo.pullRequest)}`]
          : ["    pull request: none yet"]),
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
              `      [${f.resolution}] ${f.ticket ?? "spec"} ${f.stage} ${f.kind}: ${f.body}`,
          ),
        ),
        ...section(
          "uncertainties",
          repo.uncertainties.map((u) => `      ${u.source}: ${u.text}`),
        ),
        ...section(
          "gate",
          repo.gate
            ? [
                `      ${repo.repo} @ ${repo.gate.commitSha.slice(0, 8)}: ${repo.gate.testsTotal ?? "?"} tests, ${repo.gate.testsSkipped ?? "?"} skipped, ${seconds(repo.gate.durationMs)} (${repo.gate.steps.map((s) => `${s.name} ${seconds(s.ms)}${s.exitCode === 0 ? "" : ` exit ${s.exitCode}`}`).join(", ")})`,
              ]
            : [],
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
    state: string;
    pauseReason: string | null;
    warnings: unknown[];
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
    ...(view.spec.pauseReason ? [`paused: ${view.spec.pauseReason}`] : []),
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
