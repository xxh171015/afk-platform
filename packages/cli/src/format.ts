// Plain-text views for people. The JSON is the API's answer, untouched (--json); these only lay it out.

interface BriefLike {
  run: { displayId: string };
  stage: string;
  result: string | null;
  output?: unknown;
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
  specs: { displayId: string; title: string; reason: string }[];
}): string {
  if (
    queue.tickets.length === 0 &&
    queue.finalizations.length === 0 &&
    queue.pullRequests.length === 0 &&
    queue.cleanups.length === 0 &&
    queue.specs.length === 0
  ) {
    return "nothing is waiting for you";
  }
  return [
    ...queue.tickets.flatMap((t) => [
      `${t.displayId}  ${t.specDisplayId}  ${stateOf(t)}  ${t.title}`,
      ...briefLines(t.brief, "    "),
    ]),
    ...queue.finalizations.flatMap((f) => [
      `${f.specDisplayId}  overall review of ${f.repo}: ${finalState(f)}`,
      ...briefLines(f.brief, "    "),
      `    then: plat spec retry-final ${f.specDisplayId}`,
    ]),
    ...queue.pullRequests.flatMap(pullRequestProblemLines),
    ...queue.cleanups.flatMap((c) => [
      `${c.specDisplayId}  clean-up of the spec did not finish: ${c.error}`,
      `    branches or pull requests may be left on the code host; try again: plat spec cleanup ${c.specDisplayId}`,
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
  upstream: { displayId: string; kind: string; state: string }[];
  downstream: { displayId: string; kind: string; state: string }[];
  runs: {
    displayId: string;
    stage: string;
    attempt: number;
    result: string | null;
    durationMs: number | null;
    contractShas: Record<string, string> | null;
    refShas: Record<string, string> | null;
  }[];
  findings: { kind: string; body: string; resolution: string }[];
}): string {
  const { ticket } = view;
  return [
    `${ticket.displayId}  ${stateOf(ticket)}  ${ticket.title}`,
    `spec ${ticket.specDisplayId}, repo ${ticket.repo}, version ${ticket.contentVersion}`,
    ...contextLines(ticket, ""),
    ...briefLines(ticket.brief),
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
        `  ${r.displayId}  ${r.stage} #${r.attempt}  ${r.result ?? "running"}${r.durationMs === null ? "" : `  ${Math.round(r.durationMs / 1000)}s`}${shaList("contracts", r.contractShas)}${shaList("refs", r.refShas)}`,
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

interface PullRequestRowLike {
  order: number;
  repo: string;
  number: number;
  url: string;
  state: string;
  draft: boolean;
  ci: string;
  review: string;
  syncError: string | null;
}

const pullRequestRow = (p: PullRequestRowLike) =>
  `${p.order}. ${p.repo} #${p.number}  ${pullState(p.state)}${p.draft ? " (draft)" : ""}  ci ${p.ci}  review ${p.review}  ${p.url}${p.syncError ? `  [could not be read: ${p.syncError}]` : ""}`;

interface PackLike {
  pullRequests: PullRequestRowLike[];
  tickets: {
    displayId: string;
    title: string;
    criteria: {
      text: string;
      tests: string[];
      status: string;
      reason: string | null;
    }[];
  }[];
  findings: {
    ticket: string | null;
    stage: string;
    kind: string;
    body: string;
    resolution: string;
  }[];
  uncertainties: { source: string; text: string }[];
  gates: {
    repo: string;
    commitSha: string;
    testsTotal: number | null;
    testsSkipped: number | null;
    durationMs: number;
    steps: { name: string; exitCode: number; ms: number }[];
  }[];
  protectedPathApprovals: { ticket: string; paths: string[] }[];
  agentSeconds: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// What a person reads before merging: the pull requests in the order to merge them, which criteria are backed by
// a passing test, what the reviews said and what the agents were unsure of, the gates, and approved exceptions.
export function acceptancePackText(pack: PackLike): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? [`  ${title}:`, ...lines] : [];
  return [
    "acceptance pack:",
    ...section(
      "pull requests (merge in this order)",
      pack.pullRequests.map((p) => `    ${pullRequestRow(p)}`),
    ),
    ...section(
      "acceptance criteria",
      pack.tickets.flatMap((t) => [
        `    ${t.displayId}  ${t.title}`,
        ...t.criteria.map(
          (c) =>
            `      [${c.status}] ${c.text}${c.tests.length ? `  (${c.tests.join(", ")})` : ""}${c.reason ? `  -- ${c.reason}` : ""}`,
        ),
      ]),
    ),
    ...section(
      "findings",
      pack.findings.map(
        (f) =>
          `    [${f.resolution}] ${f.ticket ?? "spec"} ${f.stage} ${f.kind}: ${f.body}`,
      ),
    ),
    ...section(
      "uncertainties",
      pack.uncertainties.map((u) => `    ${u.source}: ${u.text}`),
    ),
    ...section(
      "gates",
      pack.gates.map(
        (g) =>
          `    ${g.repo} @ ${g.commitSha.slice(0, 8)}: ${g.testsTotal ?? "?"} tests, ${g.testsSkipped ?? "?"} skipped, ${seconds(g.durationMs)} (${g.steps.map((s) => `${s.name} ${seconds(s.ms)}${s.exitCode === 0 ? "" : ` exit ${s.exitCode}`}`).join(", ")})`,
      ),
    ),
    ...section(
      "approved protected paths",
      pack.protectedPathApprovals.map(
        (a) => `    ${a.ticket}: ${a.paths.join(", ")}`,
      ),
    ),
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
  pullRequests?: PullRequestRowLike[];
  acceptancePack?: PackLike | null;
}): string {
  return [
    `${view.spec.displayId}  ${view.spec.state}  ${view.spec.title}`,
    ...(view.spec.pauseReason ? [`paused: ${view.spec.pauseReason}`] : []),
    "tickets:",
    ...view.tickets.flatMap((t) => [
      `  ${t.displayId}  ${stateOf(t)}  [${t.repo}]  ${t.title}`,
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
