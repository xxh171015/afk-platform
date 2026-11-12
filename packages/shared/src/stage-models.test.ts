import { describe, expect, it } from "vitest";
import {
  mergeStageModels,
  modelFor,
  parseStageModels,
  StageModelsSchema,
} from "./stage-models.ts";

describe("StageModelsSchema", () => {
  it("accepts the three roles and refuses any other key", () => {
    expect(
      StageModelsSchema.safeParse({
        standards: "s",
        "update-branch": "u",
        "merge-fix": "m",
      }).success,
    ).toBe(true);
    expect(StageModelsSchema.safeParse({ implement: "x" }).success).toBe(false);
    expect(StageModelsSchema.safeParse({ review: "x" }).success).toBe(false);
    expect(StageModelsSchema.safeParse({ spec: "x" }).success).toBe(false);
  });
});

describe("parseStageModels / mergeStageModels", () => {
  it("drops empty values, merges a patch, and clears a role with an empty string", () => {
    expect(parseStageModels({ standards: "s", "merge-fix": "" })).toEqual({
      standards: "s",
    });
    expect(parseStageModels({ implement: "x" })).toEqual({});
    expect(mergeStageModels({ standards: "s" }, { "merge-fix": "m" })).toEqual({
      standards: "s",
      "merge-fix": "m",
    });
    expect(mergeStageModels({ standards: "s" }, { standards: "" })).toEqual({});
  });
});

describe("modelFor", () => {
  const models = {
    standards: "standards-model",
    "update-branch": "update-model",
    "merge-fix": "merge-model",
  };

  it("uses the Standards override on both review layers, and the default model on Spec and implement", () => {
    expect(
      modelFor({
        stage: "review",
        axis: "standards",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("standards-model");
    expect(
      modelFor({
        stage: "final-review",
        axis: "standards",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("standards-model");
    expect(
      modelFor({
        stage: "review",
        axis: "spec",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("default-model");
    expect(
      modelFor({
        stage: "implement",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("default-model");
  });

  it("uses the update-branch and merge-fix overrides on those stages", () => {
    expect(
      modelFor({
        stage: "update-branch",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("update-model");
    expect(
      modelFor({
        stage: "merge-fix",
        stageModels: models,
        defaultModel: "default-model",
      }),
    ).toBe("merge-model");
  });

  it("falls back to the worker model when the project sets nothing", () => {
    expect(modelFor({ stage: "implement", workerModel: "worker-model" })).toBe(
      "worker-model",
    );
    expect(
      modelFor({
        stage: "review",
        axis: "standards",
        workerModel: "worker-model",
      }),
    ).toBe("worker-model");
  });
});
