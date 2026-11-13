import { z } from "zod";

// What an agent records on a code-changing Run (GLOSSARY Decision). The ticket does not stop:
// AFK is do-not-wait, not do-not-tell. Legacy `uncertainties` string arrays still parse as `choice`.

export const DECISION_KINDS = [
  "choice",
  "conflict",
  "known-gap",
  "deferred",
  "workaround",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_KIND_LABELS: Record<DecisionKind, string> = {
  choice: "小事",
  conflict: "冲突",
  "known-gap": "已知缺口",
  deferred: "留给别的票",
  workaround: "绕过",
};

export type Decision = {
  kind: DecisionKind;
  text: string;
  ref?: string;
};

export const DecisionSchema = z
  .object({
    kind: z.enum(DECISION_KINDS),
    text: z.string().min(1),
    ref: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.kind === "deferred") {
      if (d.ref === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "deferred needs a ref",
          path: ["ref"],
        });
      } else if (!/^(T-\d+|new)$/.test(d.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "deferred ref must be T-n or new",
          path: ["ref"],
        });
      }
    } else if (d.ref !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ref is only for deferred",
        path: ["ref"],
      });
    }
  });

export const DecisionsField = z.union([
  z.array(DecisionSchema),
  z
    .array(z.string())
    .transform((texts) =>
      texts
        .filter((text) => text.length > 0)
        .map((text) => ({ kind: "choice" as const, text })),
    ),
]);

export function coerceDecisionsInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.decisions === undefined && Array.isArray(obj.uncertainties)) {
    obj.decisions = obj.uncertainties;
  }
  delete obj.uncertainties;
  if (obj.decisions === undefined) obj.decisions = [];
  return obj;
}

export function decisionsOf(output: unknown): Decision[] {
  if (!output || typeof output !== "object") return [];
  const rec = output as Record<string, unknown>;
  const parsed = DecisionsField.safeParse(
    rec.decisions !== undefined ? rec.decisions : rec.uncertainties,
  );
  return parsed.success ? parsed.data : [];
}

export function isListedDecisionKind(kind: string): boolean {
  return kind === "conflict" || kind === "known-gap";
}

export function decisionTally<T extends { kind: string }>(
  items: readonly T[],
): { listed: T[]; counted: T[]; choice: number; workaround: number } {
  const counted = items.filter(
    (item) => item.kind === "choice" || item.kind === "workaround",
  );
  return {
    listed: items.filter((item) => isListedDecisionKind(item.kind)),
    counted,
    choice: counted.filter((item) => item.kind === "choice").length,
    workaround: counted.filter((item) => item.kind === "workaround").length,
  };
}

export const CODE_CHANGING_STAGES = [
  "implement",
  "gate-fix",
  "review-fix",
  "merge-fix",
  "final-fix",
  "update-branch",
] as const;
