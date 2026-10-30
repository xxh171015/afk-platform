// The ONLY module that imports Sandcastle (pinned to 0.12.0 in package.json). If it ever has to be patched or
// forked, this file is the whole blast radius: everything else in the platform talks to the AgentRunner and
// GateSandbox interfaces, and tests use fakes.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createSandbox,
  cursor,
  Output,
  run,
  StructuredOutputError,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { z } from "zod";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./agent.ts";
import type { GateSandbox, SandboxSession } from "./gate.ts";

export interface SandcastleConfig {
  cwd: string; // the slot's clone of the repo: the agent and the gate only ever see this copy
  image: string; // the project's sandbox image
  model: string;
  skillsMount: string; // host directory with the pinned skills
  cursorApiKey: string;
  logDir: string; // where the raw logs of this task go
  onNote?: (line: string) => void; // things worth a line in the run log
}

// The abort reason of the wall-clock limit; classifyAgentError recognises it again.
const WALL_CLOCK_REASON = "wall-clock";
const JOB_LOST_REASON = "job-lost";

export const SKILLS_SANDBOX_PATH = "/home/agent/.cursor/skills";
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

const provider = (
  config: SandcastleConfig,
  ctxDir?: string,
  refs?: readonly { name: string; dir: string }[],
) =>
  docker({
    imageName: config.image,
    mounts: sandboxMounts({ ctxDir, skillsMount: config.skillsMount, refs }),
  });

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
        sandbox: provider(config, options.ctxDir, options.refs),
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

  async open(ref: string): Promise<SandboxSession> {
    const sandbox = await createSandbox({
      branch: ref,
      sandbox: provider(this.config),
      cwd: this.config.cwd,
    });
    return {
      exec: async (command) => {
        const result = await sandbox.exec(command);
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
