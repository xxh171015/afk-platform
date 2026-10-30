// The states of a row in the job queue (docs/specs/m1-platform.md「作业队列」).
export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];
