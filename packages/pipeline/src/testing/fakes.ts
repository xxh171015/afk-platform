import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent.ts";
import { git, gitOrThrow } from "../exec.ts";
import type { GateSandbox, SandboxSession } from "../gate.ts";

// Stand-ins for the two things the pipeline cannot run for real in tests: an agent in a sandbox, and the
// gate's sandbox. They do real git and real shell work in temporary directories, so what the pipeline does
// with their results is exercised for real.

export interface FakeAgentStep {
  files?: Record<string, string>; // written, then committed
  message?: string; // commit message; no commit when there are no files
  output?: unknown; // the agent's structured result, validated against the stage's schema
  error?: { kind: "invalid-output" | "timeout" | "other"; message: string };
}

export interface FakeAgentContext {
  stage: string;
  branch: string;
  dir: string; // the worktree the agent works in
  context: (file: string) => string | undefined; // reads /context/<file>
}

export class FakeAgentRunner implements AgentRunner {
  readonly calls: AgentRunOptions<z.ZodType>[] = [];
  private readonly repoDir: string;
  private readonly script: (ctx: FakeAgentContext) => FakeAgentStep;

  constructor(
    repoDir: string,
    script: (ctx: FakeAgentContext) => FakeAgentStep,
  ) {
    this.repoDir = repoDir;
    this.script = script;
  }

  async run<Schema extends z.ZodType>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentRunResult<z.infer<Schema>>> {
    this.calls.push(options);
    const started = Date.now();
    // like Sandcastle: the branch is created from baseBranch when it does not exist yet
    if (
      git(this.repoDir, ["rev-parse", "--verify", "--quiet", options.branch])
        .code !== 0
    ) {
      gitOrThrow(this.repoDir, ["branch", options.branch, options.baseBranch]);
    }
    const dir = mkdtempSync(join(tmpdir(), "afk-fake-agent-"));
    const worktree = join(dir, "wt");
    gitOrThrow(this.repoDir, [
      "worktree",
      "add",
      "--quiet",
      worktree,
      options.branch,
    ]);
    try {
      const before = gitOrThrow(worktree, ["rev-parse", "HEAD"]);
      const step = this.script({
        stage: options.stage,
        branch: options.branch,
        dir: worktree,
        context: (file) => {
          const path = join(options.ctxDir, file);
          return existsSync(path) ? readFileSync(path, "utf8") : undefined;
        },
      });
      for (const [path, content] of Object.entries(step.files ?? {})) {
        mkdirSync(dirname(join(worktree, path)), { recursive: true });
        writeFileSync(join(worktree, path), content);
      }
      if (step.files && Object.keys(step.files).length > 0) {
        gitOrThrow(worktree, ["add", "-A"]);
        git(worktree, [
          "-c",
          "user.name=Fake Agent",
          "-c",
          "user.email=agent@example.com",
          "commit",
          "--quiet",
          "-m",
          step.message ?? "agent change",
        ]);
      }
      const commits = gitOrThrow(worktree, [
        "rev-list",
        "--reverse",
        `${before}..HEAD`,
      ])
        .split("\n")
        .filter(Boolean);
      const durationMs = Date.now() - started;
      if (step.error) {
        return {
          commits,
          error: step.error.message,
          errorKind: step.error.kind,
          durationMs,
        };
      }
      const parsed = options.schema.safeParse(step.output);
      if (!parsed.success) {
        return {
          commits,
          error: parsed.error.message.slice(0, 400),
          errorKind: "invalid-output",
          durationMs,
        };
      }
      return { output: parsed.data, commits, durationMs };
    } finally {
      git(this.repoDir, ["worktree", "remove", "--force", worktree]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The gate's "fresh sandbox": a detached worktree of the ref, where commands really run with `sh -c`.
export class FakeGateSandbox implements GateSandbox {
  readonly opened: string[] = [];
  private readonly repoDir: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
  }

  async open(ref: string): Promise<SandboxSession> {
    this.opened.push(ref);
    const dir = mkdtempSync(join(tmpdir(), "afk-fake-gate-"));
    const worktree = join(dir, "wt");
    gitOrThrow(this.repoDir, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
      ref,
    ]);
    return {
      exec: async (command) => {
        const result = spawnSync("sh", ["-c", command], {
          cwd: worktree,
          encoding: "utf8",
        });
        return {
          exitCode: result.status ?? -1,
          output: (result.stdout ?? "") + (result.stderr ?? ""),
        };
      },
      readFile: async (path) => {
        const full = join(worktree, path);
        return existsSync(full) ? readFileSync(full, "utf8") : undefined;
      },
      close: async () => {
        git(this.repoDir, ["worktree", "remove", "--force", worktree]);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
}
