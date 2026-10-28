import { z } from "zod";
import { SPEC_STATES } from "./spec-state.ts";
import { BLOCKED_REASONS, TICKET_STATES } from "./ticket-state.ts";

const IdSchema = z.number().int().positive();

export const TICKET_TYPES = [
  "contract",
  "implementation",
  "integration",
  "fix",
  "system",
] as const;

export const TicketSchema = z
  .object({
    id: IdSchema,
    specId: IdSchema,
    repoId: IdSchema,
    type: z.enum(TICKET_TYPES),
    title: z.string().min(1),
    body: z.string(),
    acceptanceCriteria: z.array(z.string()),
    modules: z.array(z.string()),
    state: z.enum(TICKET_STATES),
    blockedReason: z.enum(BLOCKED_REASONS).optional(),
    contentVersion: z.number().int().min(1),
    contractSha: z.string().min(1).optional(),
    allowedProtectedPaths: z.array(z.string()).default([]),
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
    if (ticket.contractSha && ticket.type !== "contract") {
      ctx.addIssue({
        code: "custom",
        path: ["contractSha"],
        message: "only a contract ticket records a contract SHA",
      });
    }
  });
export type Ticket = z.infer<typeof TicketSchema>;

export const EDGE_KINDS = ["blocks", "contract"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EdgeSchema = z
  .object({
    from: IdSchema,
    to: IdSchema,
    kind: z.enum(EDGE_KINDS),
  })
  .refine((edge) => edge.from !== edge.to, {
    message: "a ticket cannot depend on itself",
  });
export type Edge = z.infer<typeof EdgeSchema>;

export const SPEC_TYPES = ["feature", "bug", "improvement"] as const;

export const SpecSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  type: z.enum(SPEC_TYPES),
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  state: z.enum(SPEC_STATES),
  sourceSpecId: IdSchema.optional(),
  // One integration branch (spec/<slug>) per repo the spec touches.
  integrationBranches: z
    .array(z.object({ repoId: IdSchema, branch: z.string().min(1) }))
    .default([]),
});
export type Spec = z.infer<typeof SpecSchema>;
