import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  adapterByHost,
  checkAppAccess,
  checkGitLabAccess,
  createAppTokenSource,
  createGitHubAdapter,
  createGitLabAdapter,
  createGitLabTokenSource,
  type HostAdapter,
  hostRepoRef,
  loadAppCredentials,
  type RepoRef,
  type TokenSource,
  tokensByHost,
} from "@afk/host";
import {
  realDocker,
  SANDBOX_SKILLS_DIR,
  SandcastleAgentRunner,
  type SandcastleConfig,
  SandcastleGateSandbox,
} from "@afk/pipeline";
import {
  DEFAULT_DISK_STOP_GIB,
  DEFAULT_DISK_WARN_GIB,
  diskGib,
  GIB,
  repoHost,
  SKILLS_SHA,
} from "@afk/shared";
import { createWorkerApi, reportCleanup, reportCodeHosts } from "./api.ts";
import { gitlabCredentialFiles, workerCodeHosts } from "./code-hosts.ts";
import { ConfigError, loadConfig, type WorkerConfig } from "./config.ts";
import { freeBytesOf } from "./disk.ts";
import { EnvironmentLimiter } from "./environments.ts";
import { pushWithToken } from "./push.ts";
import { RepoStore } from "./repos.ts";
import { retainWorkerFiles } from "./retention.ts";
import { removeSandboxesUnder } from "./sandboxes.ts";
import { SlotManager } from "./slots.ts";
import { SnapshotStore } from "./snapshots.ts";
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
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  fail(...error.problems);
}

// The GitHub App is there for repos on github.com; a worker for GitLab only goes without it.
let credentials: ReturnType<typeof loadAppCredentials> | undefined;
if (existsSync(config.credentialsDir)) {
  try {
    credentials = loadAppCredentials(config.credentialsDir);
  } catch (error) {
    fail(
      `GitHub App credentials in ${config.credentialsDir}: ${reason(error)}`,
    );
  }
}
const codeHosts = workerCodeHosts({
  githubApp: credentials !== undefined,
  gitlabDir: config.gitlabDir,
});
if (codeHosts.length === 0)
  fail(
    `no code host credentials: put the GitHub App credentials in ${config.credentialsDir}, or a GitLab PAT in ${config.gitlabDir}/<host>`,
  );

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

// The platform registers repos only on the hosts some worker has credentials for.
await reportCodeHosts(config.apiUrl, config.workerId, codeHosts).catch(
  (error) => fail(`could not tell the API the code hosts: ${reason(error)}`),
);
// each repo's host calls and tokens go to the credentials of its own host
const appTokens = credentials
  ? createAppTokenSource({ credentials })
  : undefined;
const gitlabFiles = gitlabCredentialFiles(config.gitlabDir);
const gitlabHosts = new Set(gitlabFiles.map((file) => file.host));
const tokenSources = new Map<string, TokenSource>(
  appTokens ? [["github.com", appTokens]] : [],
);
const adapters = new Map<string, HostAdapter>(
  appTokens ? [["github.com", createGitHubAdapter({ tokens: appTokens })]] : [],
);
for (const { host, path } of gitlabFiles) {
  const gitlabTokens = createGitLabTokenSource({ path });
  tokenSources.set(host, gitlabTokens);
  adapters.set(
    host,
    createGitLabAdapter({
      tokens: gitlabTokens,
      apiUrl: `https://${host}/api/v4`,
    }),
  );
}
const tokens = tokensByHost(tokenSources);
const hostAdapter = adapterByHost(adapters);
const api = createWorkerApi(config.apiUrl, config.workerId);
const repos = new RepoStore(join(config.home, "repos"));
const snapshots = new SnapshotStore(join(config.home, "snapshots"));
const slotsRoot = join(config.home, "slots");
// Each run writes its raw logs to a folder of its own: two slots at once, or one run after another, never share one.
const sandcastle = (cwd: string, runId?: string): SandcastleConfig => ({
  cwd,
  image: config.image,
  model: config.model,
  skillsMount: SANDBOX_SKILLS_DIR,
  cursorApiKey: config.cursorApiKey,
  limits: config.sandboxLimits,
  ...(runId ? { runId } : {}),
  ...(config.npmRegistries.length > 0
    ? { sandboxEnv: { AFK_NPM_REGISTRIES: config.npmRegistries.join(" ") } }
    : {}),
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

let lastCleaned = { sandboxLogs: 0, salvage: 0, snapshots: 0 };
const sweepHome = async () => {
  lastCleaned = retainWorkerFiles({ home: config.home });
  const parts = [
    lastCleaned.sandboxLogs && `${lastCleaned.sandboxLogs} sandbox-log(s)`,
    lastCleaned.salvage && `${lastCleaned.salvage} salvage`,
    lastCleaned.snapshots && `${lastCleaned.snapshots} snapshot(s)`,
  ].filter(Boolean);
  if (parts.length > 0) log(`removed ${parts.join(", ")}`);
  const freeBytes = await freeBytesOf(config.home).catch(() => undefined);
  await reportCleanup(
    config.apiUrl,
    config.workerId,
    lastCleaned,
    freeBytes,
  ).catch((error) => log(`could not report cleanup: ${reason(error)}`));
};
await sweepHome();
const retentionTimer = setInterval(() => void sweepHome(), 24 * 60 * 60 * 1000);
retentionTimer.unref();
log(
  `worker ${config.workerId}: ${config.slots} slot(s), api ${config.apiUrl}, home ${config.home}`,
);
await runWorker({
  api,
  disk: {
    free: () => freeBytesOf(config.home),
    warnBelow: diskGib("AFK_DISK_WARN_GIB", DEFAULT_DISK_WARN_GIB) * GIB,
    stopBelow: diskGib("AFK_DISK_STOP_GIB", DEFAULT_DISK_STOP_GIB) * GIB,
    report: async (freeBytes) => {
      await reportCleanup(
        config.apiUrl,
        config.workerId,
        lastCleaned,
        freeBytes,
      ).catch((error) => log(`could not report cleanup: ${reason(error)}`));
    },
  },
  host: {
    adapter: hostAdapter,
    repoRef: hostRepoRef,
    checkAccess: async (repo: RepoRef) => {
      const host = repo.host;
      if (host && gitlabHosts.has(host)) {
        const file = gitlabFiles.find((row) => row.host === host);
        if (!file) throw new Error(`this worker has no GitLab PAT for ${host}`);
        return checkGitLabAccess(
          {
            tokens: createGitLabTokenSource({ path: file.path }),
            apiUrl: `https://${host}/api/v4`,
          },
          repo,
        );
      }
      if (!credentials)
        throw new Error("this worker has no GitHub App credentials");
      return checkAppAccess({ credentials }, repo);
    },
  },
  executor: {
    slots: new SlotManager({
      root: slotsRoot,
      count: config.slots,
      mainCloneFor: (name, url) => repos.dirFor(name, url),
      salvageDir: join(config.home, "salvage"),
      isHeld: (jobId, attempt) => api.isHeld(jobId, attempt),
      removeSandboxes: (dir) => removeSandboxesUnder(dir, undefined, log),
      log,
    }),
    repos,
    snapshots,
    push: pushWithToken,
    credentials: {
      tokens,
      repoRef: hostRepoRef,
      gitUser: (url) =>
        gitlabHosts.has(repoHost(url) ?? "") ? "oauth2" : undefined,
    },
    docker: realDocker,
    environments: new EnvironmentLimiter(),
    makeAgentRunner: (slotDir, runId) =>
      new SandcastleAgentRunner(sandcastle(slotDir, runId)),
    makeGateSandbox: (slotDir, runId) =>
      new SandcastleGateSandbox(sandcastle(slotDir, runId)),
    model: config.model,
    skillsSha: SKILLS_SHA, // what SANDBOX_SKILLS_DIR was copied at
    secrets: [config.cursorApiKey],
  },
  concurrency: config.slots,
  signal: stop.signal,
  log,
});
log("worker stopped");
