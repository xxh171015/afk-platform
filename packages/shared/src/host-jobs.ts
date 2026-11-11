// The jobs that talk to the code host, and the capability a worker needs to take them: only a worker that holds
// the host's credentials declares it (docs/design.md「代码托管」).
export const HOST_JOB_TYPES = [
  "open-pr",
  "host-sync",
  "spec-cleanup",
  "pr-ready",
  "patch-pr-body",
  "repo-access",
  "index-pr-links",
] as const;
export const HOST_CAPABILITY = "host";

// A trial-merge job merge-trees two specs' integration branches. It is not a job for the code host:
// any worker can claim it, and it has no lock key.
export const TRIAL_MERGE_JOB = "trial-merge";

// A checkDefault trial-merge names the default branch as this peer so the worker merge-trees against
// it the same way it does another spec, without a new job type. Real spec ids start at 1.
export const DEFAULT_BRANCH_PEER_SPEC_ID = 0;
