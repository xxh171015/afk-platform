import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAppTokenSource,
  createGitHubAdapter,
  loadAppCredentials,
} from "@afk/host";
import {
  GateCache,
  SandcastleAgentRunner,
  type SandcastleConfig,
  SandcastleGateSandbox,
} from "@afk/pipeline";
import { DEFAULT_LIMITS } from "@afk/shared";
import { createWorkerApi } from "./api.ts";
import { ConfigError, loadConfig, type WorkerConfig } from "./config.ts";
import { pushWithToken } from "./push.ts";
import { RepoStore } from "./repos.ts";
import { SlotManager } from "./slots.ts";
import { runWorker } from "./worker.ts";

// `pnpm worker`: a worker on this machine, with the real sandbox, the GitHub App and the folders under ~/.afk.

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let config: WorkerConfig;
try {
  config = loadConfig({
    env: process.env,
    homedir: homedir(),
    readFile: (path) =>
      existsSync(path) ? readFileSync(path, "utf8") : undefined,
    isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  fail(
    `the worker cannot start:\n${error.problems.map((p) => `  - ${p}`).join("\n")}`,
  );
}

let credentials: ReturnType<typeof loadAppCredentials>;
try {
  credentials = loadAppCredentials(config.credentialsDir);
} catch (error) {
  fail(
    `the worker cannot start:\n  - GitHub App credentials in ${config.credentialsDir}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// An API that is not there is the commonest mistake: say so now instead of failing at the first claim.
try {
  const response = await fetch(`${config.apiUrl}/specs`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  fail(
    `the worker cannot start:\n  - the API at ${config.apiUrl} does not answer (${error instanceof Error ? error.message : String(error)}); start it with pnpm api`,
  );
}

const tokens = createAppTokenSource({ credentials });
const api = createWorkerApi(config.apiUrl, config.workerId);
const repos = new RepoStore(join(config.home, "repos"));
const sandcastle = (cwd: string): SandcastleConfig => ({
  cwd,
  image: config.image,
  model: config.model,
  skillsMount: config.skillsDir,
  cursorApiKey: config.cursorApiKey,
  logDir: join(config.home, "sandbox-logs"),
  onNote: log,
});

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    log(
      `${signal}: finishing the jobs in hand is not attempted; leases will run out and the jobs go to the queue again`,
    );
    stop.abort();
    // a job in the middle of an agent run is abandoned on purpose: its lease runs out and it is dispatched again
    setTimeout(() => process.exit(0), 1_000).unref();
  });

log(
  `worker ${config.workerId}: ${config.slots} slot(s), api ${config.apiUrl}, home ${config.home}`,
);
await runWorker({
  api,
  host: { adapter: createGitHubAdapter({ tokens }) },
  executor: {
    slots: new SlotManager({
      root: join(config.home, "slots"),
      count: config.slots,
      mainCloneFor: (role) => repos.dirFor(role),
      salvageDir: join(config.home, "salvage"),
      isHeld: (jobId, attempt) => api.isHeld(jobId, attempt),
      log,
    }),
    repos,
    push: pushWithToken,
    credentials: { tokens },
    gateCache: new GateCache(),
    makeAgentRunner: (slotDir) =>
      new SandcastleAgentRunner(sandcastle(slotDir)),
    makeGateSandbox: (slotDir) =>
      new SandcastleGateSandbox(sandcastle(slotDir)),
    idleSeconds: DEFAULT_LIMITS.runIdleSeconds,
    wallClockMs: DEFAULT_LIMITS.runWallclockSeconds * 1000,
  },
  concurrency: config.slots,
  signal: stop.signal,
  log,
});
