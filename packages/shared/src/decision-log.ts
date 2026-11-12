import {
  CODE_CHANGING_STAGES,
  type DecisionKind,
  decisionsOf,
} from "./decisions.ts";
import { formatDisplayId } from "./display-id.ts";
import { type Ruling, rulingsOf } from "./rulings.ts";

// Decision log in /context: this ticket's earlier Decisions, plus done siblings, plus wrap-up
// runs for a spec-level stage. Computed from Run output; no extra table. Identity is R-n#index.

export type DecisionLogItem = {
  id: string;
  run: string;
  stage: string;
  kind: DecisionKind;
  text: string;
  ref?: string;
};

export type DecisionLogGroup = {
  displayId: string;
  decisions: DecisionLogItem[];
  rulings: Ruling[];
};

export type DecisionLog = {
  ticket: DecisionLogGroup | null;
  doneTickets: DecisionLogGroup[];
  spec: DecisionLogGroup | null;
};

export type DecisionLogRun = {
  id: number;
  stage: string;
  ticketId: number | null;
  axis?: string | null;
  output: unknown;
};

export function decisionId(runId: number, index: number): string {
  return `${formatDisplayId("run", runId)}#${index}`;
}

export function itemsFromRun(run: DecisionLogRun): DecisionLogItem[] {
  if (!(CODE_CHANGING_STAGES as readonly string[]).includes(run.stage))
    return [];
  const runDisplay = formatDisplayId("run", run.id);
  return decisionsOf(run.output).map((decision, index) => ({
    id: decisionId(run.id, index),
    run: runDisplay,
    stage: run.stage,
    kind: decision.kind,
    text: decision.text,
    ...(decision.ref ? { ref: decision.ref } : {}),
  }));
}

function rulingsFromRun(run: DecisionLogRun): Ruling[] {
  if (run.stage !== "review" && run.stage !== "final-review") return [];
  if (run.axis === "standards") return [];
  return rulingsOf(run.output);
}

export function decisionLogFromRuns(input: {
  specDisplayId: string;
  ticketId: number | null;
  ticketDisplayId: string | null;
  currentRunId: number | null;
  tickets: { id: number; state: string }[];
  runs: DecisionLogRun[];
}): DecisionLog {
  const prior = input.runs.filter((run) => run.id !== input.currentRunId);
  const group = (
    displayId: string,
    runs: DecisionLogRun[],
  ): DecisionLogGroup => ({
    displayId,
    decisions: runs.flatMap(itemsFromRun),
    rulings: runs.flatMap(rulingsFromRun),
  });
  const ofTicket = (ticketId: number) =>
    prior.filter((run) => run.ticketId === ticketId);
  // Ticket stages: only done siblings. Wrap-up / update-branch: every ticket (the whole spec).
  const listed =
    input.ticketId == null
      ? input.tickets
      : input.tickets.filter(
          (ticket) => ticket.state === "done" && ticket.id !== input.ticketId,
        );
  const doneTickets = listed.map((ticket) =>
    group(formatDisplayId("ticket", ticket.id), ofTicket(ticket.id)),
  );
  const specRuns = prior.filter((run) => run.ticketId == null);
  return {
    ticket:
      input.ticketDisplayId != null && input.ticketId != null
        ? group(input.ticketDisplayId, ofTicket(input.ticketId))
        : null,
    doneTickets,
    spec: input.ticketId == null ? group(input.specDisplayId, specRuns) : null,
  };
}
