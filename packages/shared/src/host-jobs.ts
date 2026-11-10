// The jobs that talk to the code host, and the capability a worker needs to take them: only a worker that holds
// the host's credentials declares it (docs/design.md「代码托管」).
export const HOST_JOB_TYPES = [
  "open-pr",
  "host-sync",
  "spec-cleanup",
  "pr-ready",
  "patch-pr-body",
  "repo-access",
] as const;
export const HOST_CAPABILITY = "host";

// A trial-merge job merge-trees two specs' integration branches. It is not a job for the code host:
// any worker can claim it, and it has no lock key.
export const TRIAL_MERGE_JOB = "trial-merge";
