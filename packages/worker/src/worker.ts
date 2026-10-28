import type { ClaimedJob, WorkerApi } from "./api.ts";
import {
  type ExecutorDeps,
  executeStage,
  InfrastructureError,
  isSuccess,
  JobLostError,
} from "./executor.ts";

// The worker loop: claim a job, get its bundle, run one stage, hand back the facts. While it works it renews
// the lease; when the API says the lease is gone it stops the local run at once (AbortSignal) and reports nothing.

export interface WorkerOptions {
  api: WorkerApi;
  executor: Omit<ExecutorDeps, "api">;
  capabilities?: string[];
  heartbeatMs?: number; // the lease is 120 s; the design renews every 30 s
  pollMs?: number; // wait between claims when the queue is empty
  concurrency?: number; // jobs at once; no more than there are slots
  stopWhenIdle?: boolean; // return as soon as a claim finds nothing (tests, one-shot runs)
  signal?: AbortSignal; // stop claiming
  log?: (line: string) => void;
}

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
  const loop = async () => {
    while (!options.signal?.aborted) {
      const job = await options.api.claim(options.capabilities ?? []);
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

// Buffers log lines and uploads them in chunks; a flush also happens when the stage ends.
class LogUploader {
  private readonly send: (chunk: string) => Promise<unknown>;
  private buffer: string[] = [];

  constructor(send: (chunk: string) => Promise<unknown>) {
    this.send = send;
  }

  add = (line: string) => {
    this.buffer.push(line.endsWith("\n") ? line : `${line}\n`);
  };

  async flush() {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join("");
    this.buffer = [];
    // a log that cannot be uploaded is never a reason to fail the stage
    await this.send(chunk).catch(() => undefined);
  }
}

export async function processJob(
  options: WorkerOptions,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const { api } = options;
  const log = (line: string) => options.log?.(`job ${job.id}: ${line}`);
  const lost = new AbortController();
  const heartbeats = setInterval(async () => {
    try {
      if ((await api.heartbeat(job)) === "lost") {
        log("the lease is gone, stopping");
        lost.abort();
      }
    } catch (error) {
      log(`heartbeat failed: ${String(error)}`); // a blip; the lease has two minutes of slack
    }
  }, options.heartbeatMs ?? 30_000);

  let uploader: LogUploader | undefined;
  try {
    const bundle = await api.bundle(job);
    if (bundle === "lost") return "abandoned";
    const runId = bundle.run?.id;
    uploader = new LogUploader((chunk) =>
      runId ? api.appendLog(runId, job, chunk) : Promise.resolve(),
    );
    const upload = uploader;
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
      },
    );
    stageLog(`result: ${body.stage} ${body.outcome}`);
    await upload.flush();
    if (lost.signal.aborted) return "abandoned";
    if ((await api.complete(job, body)) === "lost") return "abandoned";
    log(`${body.stage} ${isSuccess(body) ? "ok" : body.outcome}`);
    return "completed";
  } catch (error) {
    await uploader?.flush();
    if (error instanceof JobLostError || lost.signal.aborted)
      return "abandoned";
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    if (!(error instanceof InfrastructureError))
      log("unexpected error, failing the job");
    await api.fail(job, message.slice(0, 1000)).catch(() => undefined);
    return "failed";
  } finally {
    clearInterval(heartbeats);
  }
}
