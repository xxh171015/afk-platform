import { z } from "zod";

// Concurrency and budget defaults (docs/specs/m1-platform.md「并发与预算默认值」). A project may override any of them.
export const DEFAULT_LIMITS = {
  workerSlots: 2, // read by the worker, not the scheduler
  projectConcurrency: 2, // agent runs at once in one project
  repoConcurrency: 2, // agent runs at once in one repo
  runIdleSeconds: 600,
  runWallclockSeconds: 60 * 60,
  ticketWallclockSeconds: 3 * 60 * 60,
  specAgentSeconds: 12 * 60 * 60, // all agent time of one spec
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

const Positive = z.number().int().min(1).max(2_147_483_647);

// Built from the defaults, so a new limit is added in one place.
export const LimitOverridesSchema = z.strictObject(
  Object.fromEntries(
    Object.keys(DEFAULT_LIMITS).map((name) => [name, Positive.optional()]),
  ) as { [K in keyof Limits]: z.ZodOptional<typeof Positive> },
);
export type LimitOverrides = z.infer<typeof LimitOverridesSchema>;

// Stored overrides that no longer parse (a limit renamed later) fall back to the defaults rather than stopping the scheduler.
export function resolveLimits(stored: unknown): Limits {
  const parsed = LimitOverridesSchema.safeParse(stored);
  return { ...DEFAULT_LIMITS, ...(parsed.success ? parsed.data : {}) };
}
