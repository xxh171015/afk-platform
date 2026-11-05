// Planning docs (GLOSSARY「Planning docs」, ADR 0005): what `plat spec confirm` sends from the planning repo and
// the platform commits onto its integration branch before any ticket starts.

// A context's glossary and ADRs, relative to where the context lives; a directory stands for everything under it.
export const CONTEXT_DOC_PATHS = ["GLOSSARY.md", "docs/adr"];

// Paths in the planning repo. A multi-context repo also has GLOSSARY_MAP_PATH at its root and, for each context it
// links to, CONTEXT_DOC_PATHS under that context.
export const PLANNING_DOC_PATHS = [...CONTEXT_DOC_PATHS, "AGENTS.md"];
export const GLOSSARY_MAP_PATH = "GLOSSARY-MAP.md";

// Planning docs are text; a patch past this has picked up something else.
export const MAX_PLANNING_PATCH_BYTES = 1_000_000;

// Where a spec's planning commit is: its job is queued or running, it exists, the patch did not apply (a person
// retries or waives), or a person gave the patch up and the default branch's head stands in.
export const PLANNING_STATES = [
  "pending",
  "done",
  "blocked",
  "waived",
] as const;
export type PlanningState = (typeof PLANNING_STATES)[number];

export const PLANNING_COMMIT_JOB = "planning-commit";

// What the worker reports back for a planning-commit job.
export type PlanningCommitResult =
  | {
      stage: "planning-commit";
      outcome: "committed" | "unchanged";
      sha: string;
    }
  | { stage: "planning-commit"; outcome: "conflict"; files: string[] };
