import { z } from "zod";

// What the worker reports after a post-review code-changing stage: whether Recheck should run.

export const RecheckTriggerSchema = z.object({
  hit: z.boolean(),
  paths: z.array(z.string().min(1)).max(500),
  fromSha: z.string().min(1),
  toSha: z.string().min(1),
});
export type RecheckTrigger = z.infer<typeof RecheckTriggerSchema>;

export function recheckTriggerOf(run?: {
  recheck?: unknown;
  output?: unknown;
}): RecheckTrigger | undefined {
  const direct = RecheckTriggerSchema.safeParse(run?.recheck);
  if (direct.success) return direct.data;
  if (
    !run?.output ||
    typeof run.output !== "object" ||
    Array.isArray(run.output)
  )
    return undefined;
  const nested = RecheckTriggerSchema.safeParse(
    (run.output as { recheck?: unknown }).recheck,
  );
  return nested.success ? nested.data : undefined;
}

export function mergeRecheckIntoOutput(
  output: unknown,
  recheck: RecheckTrigger | undefined,
): unknown {
  if (!recheck) return output;
  if (output !== null && typeof output === "object" && !Array.isArray(output))
    return { ...output, recheck };
  return { value: output, recheck };
}
