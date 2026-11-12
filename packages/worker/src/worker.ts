import {
  DEFAULT_DISK_WARN_GIB,
  type DiskLevel,
  diskLevel,
  formatGib,
  GIB,
  HOST_CAPABILITY,
  HOST_JOB_TYPES,
  MAX_LOG_CHUNK_BYTES,
  PLANNING_COMMIT_JOB,
  TRIAL_MERGE_JOB,
} from "@afk/shared";
import type { ClaimedJob, WorkerApi } from "./api.ts";
import { withCredentials } from "./credentials.ts";
import {
  type ExecutorDeps,
  executeStage,
  InfrastructureError,
  isSuccess,
  JobLostError,
  NoFreeSlotError,
} from "./executor.ts";
import { type HostDeps, runHostTask } from "./host.ts";
import { runPlanningCommit } from "./planning.ts";
import { rawLogSink } from "./raw-log.ts";
import { READINESS_GATE_JOB, runReadinessGate } from "./readiness.ts";
import { runTrialMerge } from "./trial-merge.ts";

// The worker loop: claim a job, get its bundle, run one stage, hand back the facts. While it works it renews
// the lease; when the API says the lease is gone it stops the local run at once (AbortSignal) and reports nothing.

export interface WorkerOptions {
  api: WorkerApi;
  executor: Omit<ExecutorDeps, "api">;
  capabilities?: string[];
  host?: HostDeps; // the code host: a worker that has it also takes the host jobs
  heartbeatMs?: number; // the lease is 120 s; the design renews every 30 s
  logFlushMs?: number; // how often a running stage uploads what it has logged so far; default 400 ms
  pollMs?: number; // wait between claims when the queue is empty
  retryMs?: number; // wait before claiming again after the API failed; default 5 s
  concurrency?: number; // jobs at once; no more than there are slots
  stopWhenIdle?: boolean; // return as soon as a claim finds nothing (tests, one-shot runs)
  signal?: AbortSignal; // stop: claim nothing more and abandon the jobs in hand
  log?: (line: string) => void;
  // Home disk: below stopBelow the loop waits instead of claiming (a running job still finishes). A report on
  // each ok/warn/stop change is how the API learns this worker's remaining space for the banner.
  disk?: {
    free: () => Promise<number>;
    stopBelow: number;
    warnBelow?: number;
    report?: (freeBytes: number) => Promise<void>;
  };
}

const MAX_FAILED_HEARTBEATS = 3;
const DEFAULT_RETRY_MS = 5_000;
const COMPLETE_ATTEMPTS = 3;
export const DEFAULT_LOG_FLUSH_MS = 400;
export const LOG_FLUSH_BYTES = 64 * 1024;

export type JobOutcome = "completed" | "failed" | "abandoned";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runWorker(
  options: WorkerOptions,
): Promise<{ jobs: number }> {
  let jobs = 0;
  const claim = () =>
    options.api.claim([
      ...(options.capabilities ?? []),
      ...(options.host ? [HOST_CAPABILITY] : []),
    ]);
  const loop = async () => {
    let lastDiskLevel: DiskLevel | undefined;
    while (!options.signal?.aborted) {
      let job: ClaimedJob | null;
      try {
        if (options.disk) {
          const free = await options.disk.free();
          const level = diskLevel(
            free,
            options.disk.warnBelow ?? DEFAULT_DISK_WARN_GIB * GIB,
            options.disk.stopBelow,
          );
          if (level !== lastDiskLevel) {
            try {
              await options.disk.report?.(free);
              lastDiskLevel = level; // only once the API has it, so a failed report is sent again
            } catch (error) {
              // the report only feeds the page's banner: claiming does not wait for it
              options.log?.(`disk report failed: ${String(error)}`);
            }
          }
          if (level === "stop") {
            options.log?.(
              `disk ${formatGib(free)} free: not claiming until above ${formatGib(options.disk.stopBelow)}`,
            );
            await sleep(options.pollMs ?? 2_000, options.signal);
            continue;
          }
        }
        job = await claim();
      } catch (error) {
        // The API or its database is down for a moment (Docker restarting, say): wait and ask again. Exiting
        // would also abandon the jobs the other loops are running.
        options.log?.(`claim failed, retrying: ${String(error)}`);
        await sleep(options.retryMs ?? DEFAULT_RETRY_MS, options.signal);
        continue;
      }
      if (!job) {
        if (options.stopWhenIdle) return;
        await sleep(options.pollMs ?? 2_000, options.signal);
        continue;
      }
      jobs += 1;
      await processJob(options, job);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 1 }, loop));
  return { jobs };
}

// Buffers log lines and uploads them in chunks; a flush also happens when the
// buffer crosses 64 KiB, and when the stage ends.
export class LogUploader {
  private readonly send: (chunk: string) => Promise<unknown>;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(send: (chunk: string) => Promise<unknown>) {
    this.send = send;
  }

  add = (line: string) => {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    this.buffer.push(text);
    this.bufferedBytes += Buffer.byteLength(text);
    if (this.bufferedBytes >= LOG_FLUSH_BYTES) void this.flush();
  };

  flush = (): Promise<void> => {
    const next = this.chain.then(() => this.flushNow());
    this.chain = next.catch(() => undefined);
    return next;
  };

  private async flushNow() {
    const lines = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    // the API takes no more than a chunk's worth at once, and raw events can come fast
    let chunk = "";
    let size = 0;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (chunk && size + bytes > MAX_LOG_CHUNK_BYTES) {
        await this.upload(chunk);
        chunk = "";
        size = 0;
      }
      chunk += line;
      size += bytes;
    }
    if (chunk) await this.upload(chunk);
  }

  // a log that cannot be uploaded is never a reason to fail the stage
  private upload(chunk: string) {
    return this.send(chunk).catch(() => undefined);
  }
}

export async function processJob(
  options: WorkerOptions,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const { api } = options;
  const log = (line: string) => options.log?.(`job ${job.id}: ${line}`);
  const lost = new AbortController();
  // A worker told to stop gives up the jobs in hand the same way as a lost lease: the local run is aborted, nothing
  // is reported, and the job is dispatched again when its lease runs out.
  const stopping = () => lost.abort();
  if (options.signal?.aborted) stopping();
  options.signal?.addEventListener("abort", stopping, { once: true });
  let failedBeats = 0;
  let heartbeatChain = Promise.resolve();
  let stoppedBeats = false;
  const heartbeats = setInterval(() => {
    if (stoppedBeats) return;
    heartbeatChain = heartbeatChain
      .then(async () => {
        if (stoppedBeats) return;
        try {
          if ((await api.heartbeat(job)) === "lost") {
            log("the lease is gone, stopping");
            lost.abort();
          }
          failedBeats = 0;
        } catch (error) {
          // A blip is fine, the lease has two minutes of slack; a run of them means the lease is as good as gone.
          failedBeats += 1;
          log(`heartbeat failed (${failedBeats}): ${String(error)}`);
          if (failedBeats >= MAX_FAILED_HEARTBEATS) {
            log("the API cannot be reached, stopping");
            lost.abort();
          }
        }
      })
      .catch(() => undefined);
  }, options.heartbeatMs ?? 30_000);

  let uploader: LogUploader | undefined;
  let stopStreaming = () => {};
  try {
    if (job.type === TRIAL_MERGE_JOB) {
      const task = await api.trialMergeTask(job);
      if (task === "lost") return "abandoned";
      const deps = await withCredentials(
        { ...options.executor, api },
        task.repo.url,
      );
      const body = runTrialMerge(deps, task, log);
      if (lost.signal.aborted) return "abandoned";
      if ((await handOver(options, job, body, log)) !== "held")
        return "abandoned";
      log(`trial-merge ${body.peers.length} peers`);
      return "completed";
    }
    if (job.type === PLANNING_COMMIT_JOB) {
      const task = await api.planningTask(job);
      if (task === "lost") return "abandoned";
      // pushes the planning repo's integration branch, with that repo's token
      const deps = await withCredentials(
        { ...options.executor, api },
        task.repo.url,
      );
      const body = runPlanningCommit(deps, task, log);
      if (lost.signal.aborted) return "abandoned";
      if ((await handOver(options, job, body, log)) !== "held")
        return "abandoned";
      log(`planning-commit ${body.outcome}`);
      return "completed";
    }
    if (job.type === READINESS_GATE_JOB) {
      const task = await api.readinessTask(job);
      if (task === "lost") return "abandoned";
      // fetches the branch with that repo's token
      const deps = await withCredentials(
        { ...options.executor, api },
        task.repo.url,
      );
      const body = await runReadinessGate(deps, task, log, lost.signal);
      if (lost.signal.aborted) return "abandoned";
      if ((await handOver(options, job, body, log)) !== "held")
        return "abandoned";
      return "completed";
    }
    if ((HOST_JOB_TYPES as readonly string[]).includes(job.type)) {
      if (!options.host)
        throw new InfrastructureError("this worker has no code host");
      const task = await api.hostTask(job);
      if (task === "lost") return "abandoned";
      if (task.kind === "index-pr-links") {
        const deps = await withCredentials(
          { ...options.executor, api },
          task.repoUrl,
        );
        const repoDir = deps.repos.ensure(
          task.repoName,
          task.repoUrl,
          task.defaultBranch,
        );
        const body = await runHostTask({ ...options.host, repoDir }, task, log);
        if (lost.signal.aborted) return "abandoned";
        if ((await handOver(options, job, body, log)) !== "held")
          return "abandoned";
        log(`${job.type} ok`);
        return "completed";
      }
      const localRepos =
        task.kind === "spec-cleanup"
          ? [
              ...new Set(
                task.branches
                  .map((item) => options.executor.repos.findByUrl(item.repoUrl))
                  .filter((dir): dir is string => dir !== undefined),
              ),
            ]
          : undefined;
      const body = await runHostTask(
        { ...options.host, ...(localRepos ? { localRepos } : {}) },
        task,
        log,
      );
      if (lost.signal.aborted) return "abandoned";
      if ((await handOver(options, job, body, log)) !== "held")
        return "abandoned";
      log(`${job.type} ok`);
      return "completed";
    }
    const bundle = await api.bundle(job);
    if (bundle === "lost") return "abandoned";
    const runId = bundle.run?.id;
    uploader = new LogUploader((chunk) =>
      runId ? api.appendLog(runId, job, chunk) : Promise.resolve(),
    );
    const upload = uploader;
    const streaming = setInterval(
      () => void upload.flush(),
      options.logFlushMs ?? DEFAULT_LOG_FLUSH_MS,
    );
    stopStreaming = () => clearInterval(streaming);
    const stageLog = (line: string) => {
      log(line);
      upload.add(line);
    };

    const body = await executeStage(
      { ...options.executor, api },
      {
        job,
        bundle,
        signal: lost.signal,
        log: stageLog,
        logRaw: rawLogSink(upload.add),
      },
    );
    stageLog(`result: ${body.stage} ${body.outcome}`);
    await upload.flush();
    if (lost.signal.aborted) return "abandoned";
    const handedOver = await handOver(options, job, body, log);
    if (handedOver !== "held") return "abandoned";
    log(`${body.stage} ${isSuccess(body) ? "ok" : body.outcome}`);
    return "completed";
  } catch (error) {
    await uploader?.flush();
    if (error instanceof JobLostError || lost.signal.aborted)
      return "abandoned";
    if (error instanceof NoFreeSlotError) {
      log("no free slot, leaving the job for later");
      return "abandoned";
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    if (!(error instanceof InfrastructureError))
      log("unexpected error, failing the job");
    await api
      .fail(
        job,
        message.slice(0, 1000),
        error instanceof InfrastructureError ? error.run : undefined,
        error instanceof InfrastructureError ? error.extraRuns : undefined,
      )
      .catch(() => undefined);
    return "failed";
  } finally {
    stoppedBeats = true;
    options.signal?.removeEventListener("abort", stopping);
    clearInterval(heartbeats);
    stopStreaming();
    await heartbeatChain;
  }
}

// The facts of a finished stage must not be lost to a hiccup: try again a few times, and if the API stays out
// of reach give the job up un-failed, so that it is dispatched again (a merge that already went through is
// recognised as merged the second time).
async function handOver(
  options: WorkerOptions,
  job: ClaimedJob,
  body: unknown,
  log: (line: string) => void,
): Promise<"held" | "lost" | "unreachable"> {
  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt++) {
    try {
      return await options.api.complete(job, body);
    } catch (error) {
      log(`could not hand in the result (try ${attempt}): ${String(error)}`);
      await sleep(Math.min(options.heartbeatMs ?? 30_000, 1_000));
    }
  }
  return "unreachable";
}
