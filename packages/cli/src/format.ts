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
  brief: BriefLike | null;
}

const stateOf = (t: Pick<TicketLike, "state" | "blockedReason">) =>
  t.blockedReason ? `${t.state} (${t.blockedReason})` : t.state;

export function blockedText(queue: {
  tickets: TicketLike[];
  specs: { displayId: string; title: string; reason: string }[];
}): string {
  if (queue.tickets.length === 0 && queue.specs.length === 0)
    return "nothing is waiting for you";
  return [
    ...queue.tickets.flatMap((t) => [
      `${t.displayId}  ${t.specDisplayId}  ${stateOf(t)}  ${t.title}`,
      ...briefLines(t.brief, "    "),
    ]),
    ...queue.specs.map(
      (s) => `${s.displayId}  paused  ${s.title}: ${s.reason}`,
    ),
  ].join("\n");
}

export function ticketText(view: {
  ticket: TicketLike & {
    acceptanceCriteria: string[];
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
  }[];
  findings: { kind: string; body: string; resolution: string }[];
}): string {
  const { ticket } = view;
  return [
    `${ticket.displayId}  ${stateOf(ticket)}  ${ticket.title}`,
    `spec ${ticket.specDisplayId}, repo ${ticket.repo}, version ${ticket.contentVersion}`,
    ...briefLines(ticket.brief),
    "acceptance:",
    ...ticket.acceptanceCriteria.map((c) => `  - ${c}`),
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
        `  ${r.displayId}  ${r.stage} #${r.attempt}  ${r.result ?? "running"}${r.durationMs === null ? "" : `  ${Math.round(r.durationMs / 1000)}s`}`,
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

export function specText(view: {
  spec: {
    displayId: string;
    title: string;
    state: string;
    pauseReason: string | null;
    warnings: unknown[];
  };
  tickets: TicketLike[];
  edges: { from: string; to: string; kind: string }[];
}): string {
  return [
    `${view.spec.displayId}  ${view.spec.state}  ${view.spec.title}`,
    ...(view.spec.pauseReason ? [`paused: ${view.spec.pauseReason}`] : []),
    "tickets:",
    ...view.tickets.flatMap((t) => [
      `  ${t.displayId}  ${stateOf(t)}  ${t.title}`,
      ...briefLines(t.brief, "      "),
    ]),
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
