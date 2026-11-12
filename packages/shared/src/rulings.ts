import { z } from "zod";
import type { DecisionLog, DecisionLogItem } from "./decision-log.ts";

// Spec-axis judgement of a conflict or known-gap (GLOSSARY Ruling). Identity is the Decision's R-n#index.

export const RULING_VERDICTS = ["accepted", "must-fix", "needs-human"] as const;
export type RulingVerdict = (typeof RULING_VERDICTS)[number];

export type Ruling = {
  id: string;
  verdict: RulingVerdict;
};

export const RulingSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(RULING_VERDICTS),
});

export function isListedForRuling(kind: string): boolean {
  return kind === "conflict" || kind === "known-gap";
}

export function rulingsOf(output: unknown): Ruling[] {
  if (!output || typeof output !== "object") return [];
  const parsed = z
    .array(RulingSchema)
    .safeParse((output as { rulings?: unknown }).rulings);
  return parsed.success ? parsed.data : [];
}

export function listedDecisionsForReview(
  log: DecisionLog,
  scope: "ticket" | "spec",
): DecisionLogItem[] {
  const groups =
    scope === "spec"
      ? [...log.doneTickets, ...(log.spec ? [log.spec] : [])]
      : log.ticket
        ? [log.ticket]
        : [];
  return groups.flatMap((group) => group.decisions);
}

export function checkReviewRulings(input: {
  decisions: { id: string; kind: string }[];
  rulings: { id: string; verdict: string }[];
  mustFix: { id?: string }[];
}): { ok: true } | { ok: false; reason: string } {
  const byId = new Map(input.rulings.map((ruling) => [ruling.id, ruling]));
  for (const decision of input.decisions) {
    if (!isListedForRuling(decision.kind)) continue;
    const ruling = byId.get(decision.id);
    if (!ruling)
      return { ok: false, reason: `missing ruling for ${decision.id}` };
    if (
      ruling.verdict === "must-fix" &&
      !input.mustFix.some((item) => item.id === decision.id)
    ) {
      return {
        ok: false,
        reason: `must-fix ruling ${decision.id} has no mustFix item`,
      };
    }
  }
  return { ok: true };
}

export type NeedsDecisionItem = {
  kind: "needs-human" | "deferred";
  id: string;
  source: string;
  text: string;
  ref?: string;
};

function deferredIsDone(
  ref: string | undefined,
  tickets: { displayId: string; state: string }[],
): boolean {
  if (!ref || ref === "new") return false;
  return tickets.some(
    (ticket) => ticket.displayId === ref && ticket.state === "done",
  );
}

export function collectNeedsDecision(input: {
  decisions: {
    id: string;
    kind: string;
    text: string;
    ref?: string;
    source: string;
  }[];
  ticketRulings: Iterable<Ruling>;
  specRulings: Iterable<Ruling>;
  tickets: { displayId: string; state: string }[];
}): NeedsDecisionItem[] {
  const ticketById = new Map(
    [...input.ticketRulings].map((ruling) => [ruling.id, ruling]),
  );
  const specById = new Map(
    [...input.specRulings].map((ruling) => [ruling.id, ruling]),
  );
  const items: NeedsDecisionItem[] = [];
  for (const decision of input.decisions) {
    if (isListedForRuling(decision.kind)) {
      const effective =
        specById.get(decision.id) ?? ticketById.get(decision.id);
      if (effective?.verdict === "needs-human") {
        items.push({
          kind: "needs-human",
          id: decision.id,
          source: decision.source,
          text: decision.text,
        });
      }
    }
    if (decision.kind === "deferred") {
      if (deferredIsDone(decision.ref, input.tickets)) continue;
      items.push({
        kind: "deferred",
        id: decision.id,
        source: decision.source,
        text: decision.text,
        ...(decision.ref ? { ref: decision.ref } : {}),
      });
    }
  }
  return items;
}
