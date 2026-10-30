import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
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
import { createWorkerApi } from "./api.ts";
import { ConfigError, loadConfig, type WorkerConfig } from "./config.ts";
import { pushWithToken } from "./push.ts";
import { RepoStore } from "./repos.ts";
import { removeSandboxesUnder } from "./sandboxes.ts";
import { SlotManager } from "./slots.ts";
import { runWorker } from "./worker.ts";

// `pnpm worker`: a worker on this machine, with the real sandbox, the GitHub App and the folders under ~/.afk.

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function fail(...problems: string[]): never {
  console.error(
    `the worker cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );
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
  fail(...error.problems);
}

let credentials: ReturnType<typeof loadAppCredentials>;
try {
  credentials = loadAppCredentials(config.credentialsDir);
} catch (error) {
  fail(`GitHub App credentials in ${config.credentialsDir}: ${reason(error)}`);
}

// Every agent run and every gate needs the sandbox image, and Docker to run it.
const image = spawnSync("docker", ["image", "inspect", config.image], {
  encoding: "utf8",
});
if (image.error) fail("docker is not available: start Docker Desktop");
if (image.status !== 0)
  fail(
    `the sandbox image ${config.image} is not built: run scripts/verify-sandbox-image.sh, or set AFK_SANDBOX_IMAGE`,
  );

// An API that is not there is the commonest mistake: say so now instead of failing at the first claim.
try {
  const response = await fetch(`${config.apiUrl}/specs`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  fail(
    `the API at ${config.apiUrl} does not answer (${reason(error)}); start it with pnpm api`,
  );
}

const tokens = createAppTokenSource({ credentials });
const api = createWorkerApi(config.apiUrl, config.workerId);
const repos = new RepoStore(join(config.home, "repos"));
const slotsRoot = join(config.home, "slots");
// Each run writes its raw logs to a folder of its own: two slots at once, or one run after another, never share one.
const sandcastle = (cwd: string): SandcastleConfig => ({
  cwd,
  image: config.image,
  model: config.model,
  skillsMount: config.skillsDir,
  cursorApiKey: config.cursorApiKey,
  logDir: join(
    config.home,
    "sandbox-logs",
    `${new Date().toISOString().replaceAll(":", "-")}-${relative(slotsRoot, cwd).replaceAll("/", "-")}`,
  ),
  onNote: log,
});

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stop.signal.aborted) {
      log(`${signal} again: exiting without waiting`);
      process.exit(130);
    }
    // Runs in hand are aborted (Sandcastle stops their containers) and their slots released; the jobs go back to
    // the queue when their leases run out. A second Ctrl-C does not wait for that.
    log(
      `${signal}: stopping; abandoning the jobs in hand (Ctrl-C again to exit at once)`,
    );
    stop.abort();
  });

log(
  `worker ${config.workerId}: ${config.slots} slot(s), api ${config.apiUrl}, home ${config.home}`,
);
await runWorker({
  api,
  host: { adapter: createGitHubAdapter({ tokens }) },
  executor: {
    slots: new SlotManager({
      root: slotsRoot,
      count: config.slots,
      mainCloneFor: (role) => repos.dirFor(role),
      salvageDir: join(config.home, "salvage"),
      isHeld: (jobId, attempt) => api.isHeld(jobId, attempt),
      removeSandboxes: (dir) => removeSandboxesUnder(dir, undefined, log),
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
    model: config.model,
    secrets: [config.cursorApiKey],
  },
  concurrency: config.slots,
  signal: stop.signal,
  log,
});
log("worker stopped");
