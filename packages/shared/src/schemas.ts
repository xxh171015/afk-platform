import { z } from "zod";
import { SPEC_STATES } from "./spec-state.ts";
import { BLOCKED_REASONS, TICKET_STATES } from "./ticket-state.ts";

const id = z.number().int().positive();

export const TICKET_TYPES = [
  "contract",
  "implementation",
  "integration",
  "fix",
  "system",
] as const;

export const TicketSchema = z
  .object({
    id,
    specId: id,
    repoId: id,
    type: z.enum(TICKET_TYPES),
    title: z.string().min(1),
    body: z.string(),
    acceptanceCriteria: z.array(z.string()),
    modules: z.array(z.string()),
    state: z.enum(TICKET_STATES),
    blockedReason: z.enum(BLOCKED_REASONS).optional(),
    contentVersion: z.number().int().min(1),
    contractSha: z.string().min(1).optional(),
  })
  .superRefine((ticket, ctx) => {
    if (ticket.state === "blocked" && !ticket.blockedReason) {
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "required when blocked",
      });
    }
    if (ticket.state !== "blocked" && ticket.blockedReason) {
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "only allowed when blocked",
      });
    }
    if (
      ticket.contractSha &&
      !(ticket.type === "contract" && ticket.state === "done")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["contractSha"],
        message: "only a done contract ticket records a contract SHA",
      });
    }
  });
export type Ticket = z.infer<typeof TicketSchema>;

export const EdgeSchema = z
  .object({
    from: id,
    to: id,
    kind: z.enum(["blocks", "contract"]),
  })
  .refine((edge) => edge.from !== edge.to, {
    message: "a ticket cannot depend on itself",
  });
export type Edge = z.infer<typeof EdgeSchema>;

export const SPEC_TYPES = ["feature", "bug", "improvement"] as const;

export const SpecSchema = z
  .object({
    id,
    projectId: id,
    type: z.enum(SPEC_TYPES),
    title: z.string().min(1),
    body: z.string(),
    state: z.enum(SPEC_STATES),
    sourceSpecId: id.optional(),
  })
  .refine((spec) => spec.sourceSpecId === undefined || spec.type === "bug", {
    path: ["sourceSpecId"],
    message: "only a bug spec points at its source spec",
  });
export type Spec = z.infer<typeof SpecSchema>;
