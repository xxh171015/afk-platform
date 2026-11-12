import { z } from "zod";

// Per-key model overrides for the cheap/read-only agent runs. Keys are not stage names: `review`
// covers both axes, so Standards is named on its own. implement, gate-fix, and Spec are not in this
// set: they keep the project default (or the worker's AFK_MODEL).

export const STAGE_MODEL_KEYS = [
  "standards",
  "update-branch",
  "merge-fix",
] as const;
export type StageModelKey = (typeof STAGE_MODEL_KEYS)[number];

const ModelName = z.string().max(200);

export const StageModelsSchema = z.strictObject(
  Object.fromEntries(
    STAGE_MODEL_KEYS.map((name) => [name, ModelName.optional()]),
  ) as { [K in StageModelKey]: z.ZodOptional<typeof ModelName> },
);
export type StageModels = {
  [K in StageModelKey]?: string;
};

function compactStageModels(models: StageModels): StageModels {
  const out: StageModels = {};
  for (const key of STAGE_MODEL_KEYS) {
    const value = models[key];
    if (value) out[key] = value;
  }
  return out;
}

// Stored jsonb that no longer parses (a key we later dropped) is treated as empty, like resolveLimits.
export function parseStageModels(stored: unknown): StageModels {
  const parsed = StageModelsSchema.safeParse(stored);
  if (!parsed.success) return {};
  return compactStageModels(parsed.data);
}

// Patch keys overlay the stored map; empty string removes that key so the default model is used again.
export function mergeStageModels(
  stored: unknown,
  patch: StageModels,
): StageModels {
  const next: StageModels = { ...parseStageModels(stored) };
  for (const key of STAGE_MODEL_KEYS) {
    if (patch[key] === undefined) continue;
    if (patch[key] === "") delete next[key];
    else next[key] = patch[key];
  }
  return compactStageModels(next);
}

export function modelFor(input: {
  stage: string;
  axis?: string | null;
  stageModels?: StageModels | null;
  defaultModel?: string | null;
  workerModel?: string | null;
}): string | undefined {
  const key: StageModelKey | undefined =
    input.axis === "standards"
      ? "standards"
      : input.stage === "update-branch"
        ? "update-branch"
        : input.stage === "merge-fix"
          ? "merge-fix"
          : undefined;
  const override = key ? input.stageModels?.[key] : undefined;
  return override || input.defaultModel || input.workerModel || undefined;
}
