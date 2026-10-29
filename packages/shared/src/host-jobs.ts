// The jobs that talk to the code host, and the capability a worker needs to take them: only a worker that holds
// the host's credentials declares it (docs/design.md「代码托管」).
export const HOST_JOB_TYPES = ["open-pr", "host-sync"] as const;
export const HOST_CAPABILITY = "host";
