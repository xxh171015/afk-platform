import type { TicketState } from "./ticket-state.ts";

export type IncomingEdge =
  | {
      kind: "blocks" | "contract";
      scope: "same-spec";
      blockerState: TicketState;
      contractSha?: string | null;
    }
  // The caller checks git: the blocker's PR is merged into main and our
  // integration branch already contains that commit (docs/design.md「依赖边什么时候算满足」).
  | { kind: "blocks" | "contract"; scope: "cross-spec"; satisfied: boolean };

export type Capacity = {
  scope: "global" | "project" | "repo";
  resource: "concurrency" | "budget";
  used: number;
  max: number;
};

export type NotRunnableReason =
  | { type: "not-pending"; state: TicketState }
  | { type: "edge-unsatisfied"; edge: IncomingEdge }
  | { type: "no-capacity"; capacity: Capacity };

export type Runnability =
  | { runnable: true }
  | { runnable: false; reasons: NotRunnableReason[] };

export interface RunnableInput {
  state: TicketState;
  edges: readonly IncomingEdge[];
  capacity: readonly Capacity[];
}

function edgeSatisfied(edge: IncomingEdge): boolean {
  if (edge.scope === "cross-spec") return edge.satisfied;
  if (edge.blockerState !== "done") return false;
  return edge.kind === "blocks" || Boolean(edge.contractSha);
}

export function isRunnable(input: RunnableInput): Runnability {
  const reasons: NotRunnableReason[] = [];
  if (input.state !== "pending")
    reasons.push({ type: "not-pending", state: input.state });
  for (const edge of input.edges) {
    if (!edgeSatisfied(edge)) reasons.push({ type: "edge-unsatisfied", edge });
  }
  for (const capacity of input.capacity) {
    if (capacity.used >= capacity.max)
      reasons.push({ type: "no-capacity", capacity });
  }
  return reasons.length === 0
    ? { runnable: true }
    : { runnable: false, reasons };
}
