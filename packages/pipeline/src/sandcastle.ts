// The ONLY module that imports Sandcastle (pinned to 0.12.0 in package.json). If it ever has to be patched or
// forked, this file is the whole blast radius: everything else in the platform talks to the AgentRunner and
// GateSandbox interfaces, and tests use fakes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createBindMountSandboxProvider,
  createSandbox,
  cursor,
  Output,
  run,
  StructuredOutputError,
} from "@ai-hero/sandcastle";
import type { z } from "zod";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./agent.ts";
import { type ExecResult, exec } from "./exec.ts";
import {
  type GateSandbox,
  type SandboxPlacement,
  type SandboxSession,
  shellQuote,
} from "./gate.ts";

export interface SandcastleConfig {
  cwd: string; // the slot's clone of the repo: the agent and the gate only ever see this copy
  image: string; // the project's sandbox image
  model: string;
  skillsMount: string; // host directory with the pinned skills
  cursorApiKey: string;
  logDir: string; // where the raw logs of this task go
  sandboxEnv?: Record<string, string>; // set in every sandbox, agent or gate (AFK_NPM_REGISTRIES)
  onNote?: (line: string) => void; // things worth a line in the run log
  runId?: string; // R-<n>, on the container as afk.run; omitted when there is no Run
  limits?: SandboxLimits; // worker env overrides; defaults fit the Mac Docker VM
  docker?: SandboxDocker; // injectable, same shape leftover cleanup uses
}

// The abort reason of the wall-clock limit; classifyAgentError recognises it again.
const WALL_CLOCK_REASON = "wall-clock";
const JOB_LOST_REASON = "job-lost";

export const SKILLS_SANDBOX_PATH = "/home/agent/.cursor/skills";
// The skills the agents run (implement, tdd, code-review, codebase-design), copied unchanged from mattpocock/skills at
// SKILLS_SHA (packages/pipeline/skills/VENDORED.md). The worker mounts this folder at SKILLS_SANDBOX_PATH.
export const SANDBOX_SKILLS_DIR = fileURLToPath(
  new URL("../skills/", import.meta.url),
);
export const CONTEXT_SANDBOX_PATH = "/context";
export const REFS_SANDBOX_PATH = "/refs";

// Read-only mounts: the context the agent reads, and the skills. Nothing else from the host is visible.
export function sandboxMounts(input: {
  ctxDir?: string;
  skillsMount: string;
  refs?: readonly { name: string; dir: string }[];
}) {
  return [
    ...(input.ctxDir
      ? [
          {
            hostPath: input.ctxDir,
            sandboxPath: CONTEXT_SANDBOX_PATH,
            readonly: true,
          },
        ]
      : []),
    ...(input.refs ?? []).map((ref) => ({
      hostPath: ref.dir,
      sandboxPath: `${REFS_SANDBOX_PATH}/${ref.name}`,
      readonly: true,
    })),
    {
      hostPath: input.skillsMount,
      sandboxPath: SKILLS_SANDBOX_PATH,
      readonly: true,
    },
  ];
}

// The only secret inside the sandbox. Git and GitHub credentials never get in.
export const agentEnv = (cursorApiKey: string) => ({
  CURSOR_API_KEY: cursorApiKey,
});

export type SandboxKind = "agent" | "gate";

export interface SandboxLimits {
  memory: string;
  pids: number;
  cpus: number;
  shmSize: string;
}

// Defaults for a Mac Docker VM of about 7.8 GiB: two slots plus one integration environment still fit.
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memory: "3g",
  pids: 4096,
  cpus: 2,
  shmSize: "1g",
};

export const SANDBOX_RUN_LABEL = "afk.run";
export const SANDBOX_KIND_LABEL = "afk.kind";

// The kernel killed the container for using too much memory (docker inspect State.OOMKilled).
export const SANDBOX_OOM_ERROR = "sandbox-oom: container OOMKilled";

export class SandboxOomError extends Error {
  readonly reason = "sandbox-oom";
  constructor() {
    super(SANDBOX_OOM_ERROR);
    this.name = "SandboxOomError";
  }
}

// Same shape leftover sandbox cleanup uses: argv in, code and stdout out.
export type SandboxDocker = (
  args: string[],
) => Pick<ExecResult, "code" | "stdout" | "timedOut">;

const LOOK_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 30_000;

const realSandboxDocker: SandboxDocker = (args) =>
  exec("docker", args, {
    timeoutMs:
      args[0] === "rm" || args[0] === "stop"
        ? REMOVE_TIMEOUT_MS
        : LOOK_TIMEOUT_MS,
  });

export interface SandboxProviderOptions {
  image: string;
  mounts: ReturnType<typeof sandboxMounts>;
  env?: Record<string, string>;
  network?: string;
  kind: SandboxKind;
  runId?: string;
  limits?: SandboxLimits;
  docker?: SandboxDocker;
}

const sandboxHomedir = "/home/agent";
const sandboxWorkspace = "/home/agent/workspace";

const volumeFlag = (mount: {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}) => {
  const options = [mount.readonly ? "ro" : undefined, "z"]
    .filter((part): part is string => part !== undefined)
    .join(",");
  return `${mount.hostPath}:${mount.sandboxPath}:${options}`;
};

function dockerExec(
  docker: SandboxDocker,
  args: string[],
  options?: { onLine?: (line: string) => void; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (docker !== realSandboxDocker) {
    const result = docker(args);
    if (options?.onLine) {
      for (const line of result.stdout.split("\n")) options.onLine(line);
    }
    return Promise.resolve({
      stdout: result.stdout,
      stderr: "",
      exitCode: result.code,
    });
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      stdio: [options?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!stdout || !stderr) {
      reject(new Error("docker exec produced no streams"));
      return;
    }
    if (options?.stdin !== undefined) {
      proc.stdin?.write(options.stdin);
      proc.stdin?.end();
    }
    proc.on("error", (error) => {
      reject(new Error(`docker exec failed: ${error.message}`));
    });
    if (options?.onLine) {
      const onLine = options.onLine;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => {
        stdoutChunks.push(line);
        onLine(line);
      });
      stderr.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(String(chunk));
      });
      proc.on("close", (code) => {
        resolve({
          stdout: stdoutChunks.join("\n"),
          stderr: stderrChunks.join(""),
          exitCode: code ?? 0,
        });
      });
      return;
    }
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(String(chunk));
    });
    stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(String(chunk));
    });
    proc.on("close", (code) => {
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });
  });
}

function inspectOomKilled(
  docker: SandboxDocker,
  containerName: string,
): boolean {
  const inspected = docker([
    "inspect",
    "--format",
    "{{.State.OOMKilled}}",
    containerName,
  ]);
  return inspected.code === 0 && /^\s*true\s*$/i.test(inspected.stdout);
}

// Bind-mount docker provider used by every Sandcastle sandbox. Hardening flags live here, not in the image.
export function sandboxProvider(options: SandboxProviderOptions) {
  const limits = options.limits ?? DEFAULT_SANDBOX_LIMITS;
  const docker = options.docker ?? realSandboxDocker;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return createBindMountSandboxProvider({
    name: "docker",
    env: options.env,
    sandboxHomedir,
    create: async (createOptions) => {
      const containerName = `sandcastle-${randomUUID()}`;
      const worktreePath =
        createOptions.mounts.find(
          (mount) => mount.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? sandboxWorkspace;
      const env = {
        ...options.env,
        ...createOptions.env,
        HOME: sandboxHomedir,
      };
      const args = [
        "run",
        "-d",
        "--name",
        containerName,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--init",
        "--pids-limit",
        String(limits.pids),
        "--memory",
        limits.memory,
        "--memory-swap",
        limits.memory,
        "--cpus",
        String(limits.cpus),
        "--shm-size",
        limits.shmSize,
        "--label",
        `${SANDBOX_KIND_LABEL}=${options.kind}`,
        ...(options.runId
          ? ["--label", `${SANDBOX_RUN_LABEL}=${options.runId}`]
          : []),
        "--user",
        `${uid}:${gid}`,
        ...Object.entries(env).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`,
        ]),
        ...[...createOptions.mounts, ...options.mounts].flatMap((mount) => [
          "-v",
          volumeFlag(mount),
        ]),
        "-w",
        worktreePath,
        ...(options.network ? ["--network", options.network] : []),
        options.image,
      ];
      const started = docker(args);
      if (started.code !== 0) {
        throw new Error(
          `docker run failed (exit ${started.code}): ${started.stdout}`.slice(
            0,
            400,
          ),
        );
      }
      return {
        worktreePath,
        exec: async (command, execOptions) => {
          const effective = execOptions?.sudo ? `sudo ${command}` : command;
          const execArgs = ["exec"];
          if (execOptions?.stdin !== undefined) execArgs.push("-i");
          if (execOptions?.cwd) execArgs.push("-w", execOptions.cwd);
          execArgs.push(containerName, "sh", "-c", effective);
          const result = await dockerExec(docker, execArgs, {
            ...(execOptions?.onLine ? { onLine: execOptions.onLine } : {}),
            ...(execOptions?.stdin !== undefined
              ? { stdin: execOptions.stdin }
              : {}),
          });
          if (
            result.exitCode !== 0 &&
            inspectOomKilled(docker, containerName)
          ) {
            throw new SandboxOomError();
          }
          return result;
        },
        copyFileIn: async (hostPath, sandboxPath) => {
          const copied = docker([
            "cp",
            hostPath,
            `${containerName}:${sandboxPath}`,
          ]);
          if (copied.code !== 0) {
            throw new Error(`docker cp (in) failed: ${copied.stdout}`);
          }
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          const copied = docker([
            "cp",
            `${containerName}:${sandboxPath}`,
            hostPath,
          ]);
          if (copied.code !== 0) {
            throw new Error(`docker cp (out) failed: ${copied.stdout}`);
          }
        },
        close: async () => {
          const oom = inspectOomKilled(docker, containerName);
          docker(["stop", containerName]);
          docker(["rm", containerName]);
          if (oom) throw new SandboxOomError();
        },
      };
    },
  });
}

const provider = (
  config: SandcastleConfig,
  kind: SandboxKind,
  ctxDir?: string,
  refs?: readonly { name: string; dir: string }[],
  placement?: SandboxPlacement,
) => {
  const env = { ...config.sandboxEnv, ...placement?.env };
  return sandboxProvider({
    image: config.image,
    mounts: sandboxMounts({ ctxDir, skillsMount: config.skillsMount, refs }),
    kind,
    ...(placement ? { network: placement.network } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(config.runId ? { runId: config.runId } : {}),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.docker ? { docker: config.docker } : {}),
  });
};

export function classifyAgentError(error: unknown): {
  message: string;
  errorKind: "invalid-output" | "timeout" | "other";
  commits: string[];
} {
  const name = error instanceof Error ? error.name : "";
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 400)
      : String(error);
  if (error instanceof StructuredOutputError) {
    return {
      message,
      errorKind: "invalid-output",
      commits: error.commits.map((c) => c.sha),
    };
  }
  const timedOut = new RegExp(`Idle|${WALL_CLOCK_REASON}|timeout`, "i").test(
    name + message,
  );
  return { message, errorKind: timedOut ? "timeout" : "other", commits: [] };
}

export class SandcastleAgentRunner implements AgentRunner {
  private readonly config: SandcastleConfig;

  constructor(config: SandcastleConfig) {
    this.config = config;
  }

  async run<Schema extends z.ZodType>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentRunResult<z.infer<Schema>>> {
    const { config } = this;
    mkdirSync(config.logDir, { recursive: true });
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error(WALL_CLOCK_REASON)),
      options.wallClockMs,
    );
    // a lost lease stops the run the same way the wall clock does
    const onJobLost = () => abort.abort(new Error(JOB_LOST_REASON));
    if (options.signal?.aborted) onJobLost();
    options.signal?.addEventListener("abort", onJobLost, { once: true });
    const started = Date.now();
    try {
      const result = await run({
        agent: cursor(options.model ?? config.model, {
          env: agentEnv(config.cursorApiKey),
        }),
        sandbox: provider(
          config,
          "agent",
          options.ctxDir,
          options.refs,
          options.placement,
        ),
        cwd: config.cwd,
        branchStrategy: {
          type: "branch",
          branch: options.branch,
          baseBranch: options.baseBranch,
        },
        promptFile: resolve(options.promptFile),
        output: Output.object({ tag: "result", schema: options.schema }),
        idleTimeoutSeconds: options.idleSeconds,
        signal: abort.signal,
        logging: {
          type: "file",
          path: join(config.logDir, `${options.stage}.log`),
          verbose: true,
          onAgentStreamEvent: (event) => {
            if (event.type !== "raw") return;
            appendFileSync(
              join(config.logDir, `${options.stage}.stream.jsonl`),
              `${event.line}\n`,
            );
            options.onRawLine?.(event.line);
          },
        },
      });
      return {
        output: result.output as z.infer<Schema>,
        commits: result.commits.map((c) => c.sha),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const failure = classifyAgentError(error);
      return {
        commits: failure.commits,
        error: failure.message,
        errorKind: failure.errorKind,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onJobLost);
    }
  }
}

// The gate's fresh sandbox: a new worktree of `ref` and a new container, with no /context and no agent output.
export class SandcastleGateSandbox implements GateSandbox {
  private readonly config: SandcastleConfig;

  constructor(config: SandcastleConfig) {
    this.config = config;
  }

  async open(
    ref: string,
    placement?: SandboxPlacement,
  ): Promise<SandboxSession> {
    const sandbox = await createSandbox({
      branch: ref,
      sandbox: provider(this.config, "gate", undefined, undefined, placement),
      cwd: this.config.cwd,
    });
    return {
      // sandbox.exec has no timeout of its own: wrap with GNU timeout inside the image.
      exec: async (command, options) => {
        const result = await sandbox.exec(
          `timeout ${options.timeoutSeconds} sh -c ${shellQuote(command)}`,
        );
        return {
          exitCode: result.exitCode,
          output: result.stdout + result.stderr,
        };
      },
      // Read from the worktree on the host: no shell quoting involved.
      readFile: async (path) => {
        const full = join(sandbox.worktreePath, path);
        return existsSync(full) ? readFileSync(full, "utf8") : undefined;
      },
      close: async () => {
        const closed = await sandbox.close();
        // uncommitted changes in the gate's worktree are kept by Sandcastle, not discarded
        if (closed.preservedWorktreePath) {
          this.config.onNote?.(
            `${ref}: the sandbox worktree kept uncommitted changes at ${closed.preservedWorktreePath}`,
          );
        }
      },
    };
  }
}
