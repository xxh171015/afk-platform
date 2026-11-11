import { GIB } from "@afk/shared";
import { serve } from "@hono/node-server";
import { type AppOptions, createApp } from "../app.ts";
import type { DiskSample } from "../disk.ts";
import { eventsHubOf } from "../events/hub.ts";
import { dispatcherOf } from "../notify/dispatch.ts";

// Tests inject remaining space so claiming and the workbench do not read the host disk.
export const TEST_DISK: DiskSample = { freeBytes: 20 * GIB, dirBytes: 0 };

export function testApp(options: AppOptions) {
  return createApp({
    statDisk: async () => TEST_DISK,
    ...options,
    feishu: {
      secretsPath:
        options.feishu?.secretsPath ?? "/nonexistent-afk-feishu-app.json",
      ...options.feishu,
    },
  });
}

// A manually advanced clock, so lease expiry never needs real waiting.
export class FakeClock {
  private current = new Date("2026-01-01T00:00:00Z");
  private timers: { id: number; at: number; fn: () => unknown }[] = [];
  private nextId = 1;
  private pending: Promise<unknown>[] = [];
  now = (): Date => new Date(this.current);
  schedule = (ms: number, fn: () => unknown): (() => void) => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current.getTime() + ms, fn });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  };
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
    const due = this.timers.filter(
      (timer) => timer.at <= this.current.getTime(),
    );
    this.timers = this.timers.filter(
      (timer) => timer.at > this.current.getTime(),
    );
    for (const timer of due) {
      const result = timer.fn();
      if (
        result !== undefined &&
        result !== null &&
        typeof (result as Promise<unknown>).then === "function"
      ) {
        this.pending.push(result as Promise<unknown>);
      }
    }
  }
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }
}

export interface RunningApi {
  url: string;
  close(): Promise<void>;
}

// The app on a real HTTP port, so the fake worker talks to it the way a real worker will.
export async function listen(app: {
  fetch: (request: Request) => Response | Promise<Response>;
}): Promise<RunningApi> {
  const hub = eventsHubOf(app);
  await hub?.whenReady();
  const dispatcher = dispatcherOf(app);
  await dispatcher?.start();
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          close: async () => {
            await dispatcher?.stop();
            await hub?.stop();
            // A leftover keep-alive or half-open socket otherwise holds close() past hookTimeout,
            // and the next test's afterEach then deletes that test's temp dirs.
            if ("closeAllConnections" in server) {
              server.closeAllConnections();
            }
            await new Promise<void>((done) => server.close(() => done()));
          },
        });
      },
    );
  });
}

export interface ClaimedJob {
  id: number;
  type: string;
  payload: unknown;
  attempt: number;
  lockKey: string | null;
  leaseExpiresAt: string;
}

export interface Reply<T> {
  status: number;
  body: T;
}

export class FakeWorker {
  readonly baseUrl: string;
  readonly id: string;
  readonly capabilities: string[];

  constructor(baseUrl: string, id: string, capabilities: string[] = []) {
    this.baseUrl = baseUrl;
    this.id = id;
    this.capabilities = capabilities;
  }

  private async post<T>(path: string, body: unknown): Promise<Reply<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  heartbeat(
    jobId: number,
    attempt: number,
  ): Promise<Reply<{ leaseExpiresAt?: string; error?: string }>> {
    return this.post(`/worker/jobs/${jobId}/heartbeat`, {
      workerId: this.id,
      attempt,
    });
  }

  prePush(
    jobId: number,
    attempt: number,
  ): Promise<Reply<{ ok?: boolean; error?: string }>> {
    return this.post(`/worker/jobs/${jobId}/pre-push`, {
      workerId: this.id,
      attempt,
    });
  }

  complete(
    jobId: number,
    attempt: number,
    result: unknown = {},
  ): Promise<Reply<{ ok?: boolean; error?: string }>> {
    return this.post(`/worker/jobs/${jobId}/complete`, {
      workerId: this.id,
      attempt,
      result,
    });
  }

  fail(
    jobId: number,
    attempt: number,
    error = "boom",
  ): Promise<Reply<{ ok?: boolean; error?: string }>> {
    return this.post(`/worker/jobs/${jobId}/fail`, {
      workerId: this.id,
      attempt,
      error,
    });
  }

  claim(): Promise<Reply<{ job: ClaimedJob | null }>> {
    return this.post("/worker/jobs/claim", {
      workerId: this.id,
      capabilities: this.capabilities,
    });
  }
}
