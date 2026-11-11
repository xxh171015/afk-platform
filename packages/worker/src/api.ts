import type { StoredGate } from "@afk/pipeline";
import {
  type ApiClient,
  type Bundle,
  createApiClient,
  type HostTask,
  type PlanningTask,
  type ReadinessTask,
  type TrialMergeTask,
} from "@afk/shared";

// The worker talks to the platform over HTTP only (docs/specs/m1-platform.md「worker 专用接口」): it has no
// database connection and does not import the api package. Every call that concerns a job carries
// (worker id, attempt); a 404 or 409 means the lease is gone and the work must stop.

export interface ClaimedJob {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  lockKey: string | null;
  leaseExpiresAt: string;
}

export type Holding = "held" | "lost";

export interface WorkerApi {
  claim(capabilities: string[]): Promise<ClaimedJob | null>;
  heartbeat(job: ClaimedJob): Promise<Holding>;
  prePush(job: ClaimedJob): Promise<Holding>;
  bundle(job: ClaimedJob): Promise<Bundle | "lost">;
  hostTask(job: ClaimedJob): Promise<HostTask | "lost">;
  planningTask(job: ClaimedJob): Promise<PlanningTask | "lost">;
  readinessTask(job: ClaimedJob): Promise<ReadinessTask | "lost">;
  trialMergeTask(job: ClaimedJob): Promise<TrialMergeTask | "lost">;
  // Is this job still running under a live lease at this attempt? Throws when the API cannot be asked.
  isHeld(jobId: number, attempt: number): Promise<boolean>;
  complete(job: ClaimedJob, result: unknown): Promise<Holding>;
  fail(job: ClaimedJob, error: string): Promise<Holding>;
  // An earlier passing gate of the job's repo; undefined when there is none or the lease is gone.
  gateResult(
    job: ClaimedJob,
    lookup: { tree: string; configBlob: string },
  ): Promise<StoredGate | undefined>;
  appendLog(runId: number, job: ClaimedJob, chunk: string): Promise<Holding>;
}

const holding = (status: number): Holding => {
  if (status === 404 || status === 409) return "lost";
  if (status >= 200 && status < 300) return "held";
  throw new Error(`the API answered ${status}`);
};

export function createWorkerApi(
  baseUrl: string,
  workerId: string,
  client: ApiClient = createApiClient(baseUrl),
): WorkerApi {
  const call = (job: ClaimedJob) => ({
    params: { path: { id: job.id } },
    body: { workerId, attempt: job.attempt },
  });
  return {
    async claim(capabilities) {
      const { data, response } = await client.POST("/worker/jobs/claim", {
        body: { workerId, capabilities },
      });
      if (!data) throw new Error(`claim failed: HTTP ${response.status}`);
      return data.job;
    },
    async heartbeat(job) {
      return holding(
        (await client.POST("/worker/jobs/{id}/heartbeat", call(job))).response
          .status,
      );
    },
    async prePush(job) {
      return holding(
        (await client.POST("/worker/jobs/{id}/pre-push", call(job))).response
          .status,
      );
    },
    async bundle(job) {
      const { data, response } = await client.GET("/worker/jobs/{id}/bundle", {
        params: {
          path: { id: job.id },
          query: { workerId, attempt: job.attempt },
        },
      });
      if (data) return data;
      if (holding(response.status) === "lost") return "lost";
      throw new Error(`bundle failed: HTTP ${response.status}`);
    },
    async isHeld(jobId, attempt) {
      const { data, response } = await client.GET("/worker/jobs/{id}/lease", {
        params: { path: { id: jobId }, query: { attempt } },
      });
      if (!data) throw new Error(`lease check failed: HTTP ${response.status}`);
      return data.held;
    },
    async hostTask(job) {
      const { data, response } = await client.GET(
        "/worker/jobs/{id}/host-task",
        {
          params: {
            path: { id: job.id },
            query: { workerId, attempt: job.attempt },
          },
        },
      );
      if (data) return data;
      if (holding(response.status) === "lost") return "lost";
      throw new Error(`host task failed: HTTP ${response.status}`);
    },
    async planningTask(job) {
      const { data, response } = await client.GET(
        "/worker/jobs/{id}/planning-task",
        {
          params: {
            path: { id: job.id },
            query: { workerId, attempt: job.attempt },
          },
        },
      );
      if (data) return data;
      if (holding(response.status) === "lost") return "lost";
      throw new Error(`planning task failed: HTTP ${response.status}`);
    },
    async trialMergeTask(job) {
      const { data, response } = await client.GET(
        "/worker/jobs/{id}/trial-merge-task",
        {
          params: {
            path: { id: job.id },
            query: { workerId, attempt: job.attempt },
          },
        },
      );
      if (data) return data;
      if (holding(response.status) === "lost") return "lost";
      throw new Error(`trial-merge task failed: HTTP ${response.status}`);
    },
    async readinessTask(job) {
      const { data, response } = await client.GET(
        "/worker/jobs/{id}/readiness-task",
        {
          params: {
            path: { id: job.id },
            query: { workerId, attempt: job.attempt },
          },
        },
      );
      if (data) return data;
      if (holding(response.status) === "lost") return "lost";
      throw new Error(`readiness task failed: HTTP ${response.status}`);
    },
    async complete(job, result) {
      const { params, body } = call(job);
      return holding(
        (
          await client.POST("/worker/jobs/{id}/complete", {
            params,
            body: { ...body, result },
          })
        ).response.status,
      );
    },
    async fail(job, error) {
      const { params, body } = call(job);
      return holding(
        (
          await client.POST("/worker/jobs/{id}/fail", {
            params,
            body: { ...body, error },
          })
        ).response.status,
      );
    },
    async gateResult(job, lookup) {
      const { params, body } = call(job);
      const { data, response } = await client.POST(
        "/worker/jobs/{id}/gate-result",
        { params, body: { ...body, ...lookup } },
      );
      if (data) return data.gate ?? undefined;
      if (holding(response.status) === "lost") return undefined;
      throw new Error(`gate result failed: HTTP ${response.status}`);
    },
    async appendLog(runId, job, chunk) {
      const status = (
        await client.POST("/worker/runs/{id}/logs", {
          params: { path: { id: runId } },
          body: { workerId, attempt: job.attempt, chunk },
        })
      ).response.status;
      if (status === 413) return "held"; // a full log is not a reason to stop working
      return holding(status);
    },
  };
}

// At start: the code hosts this worker has credentials for (code-hosts.ts), so the platform knows which repos it can
// work on and what kind of host each is on.
export async function reportCodeHosts(
  baseUrl: string,
  workerId: string,
  hosts: { host: string; kind: "github" | "gitlab" }[],
  client: ApiClient = createApiClient(baseUrl),
): Promise<void> {
  const { response } = await client.POST("/worker/hosts", {
    body: { workerId, hosts },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

// After a home sweep: how many sandbox-logs, salvage dirs and snapshots went, so the status area can show it.
export async function reportCleanup(
  baseUrl: string,
  workerId: string,
  cleaned: {
    sandboxLogs: number;
    salvage: number;
    snapshots: number;
  },
  freeBytes?: number,
  client: ApiClient = createApiClient(baseUrl),
): Promise<void> {
  const { response } = await client.POST("/worker/status", {
    body: {
      workerId,
      cleaned,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
