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
import type { GateSandbox, SandboxPlacement, SandboxSession } from "../gate.ts";
import type { DockerCli, DockerResult } from "../integration-env.ts";

// Stand-ins for the two things the pipeline cannot run for real in tests: an agent in a sandbox, and the
// gate's sandbox. They do real git and real shell work in temporary directories, so what the pipeline does
// with their results is exercised for real.

export interface FakeAgentStep {
  files?: Record<string, string>; // written, then committed
  remove?: string[]; // deleted, then committed
  message?: string; // commit message; no commit when there are no files
  output?: unknown; // the agent's structured result, validated against the stage's schema
  error?: { kind: "invalid-output" | "timeout" | "other"; message: string };
  rawLines?: string[]; // Cursor's event lines, as the run produces them
}

export interface FakeAgentContext {
  stage: string;
  branch: string;
  dir: string; // the worktree the agent works in
  context: (file: string) => string | undefined; // reads /context/<file>
  signal?: AbortSignal; // aborted when the job is lost
  idleSeconds: number; // the limits and the model the run was asked for
  wallClockMs: number;
  model?: string;
}

export class FakeAgentRunner implements AgentRunner {
  readonly calls: AgentRunOptions<z.ZodType>[] = [];
  private readonly repoDir: string;
  private readonly script: (
    ctx: FakeAgentContext,
  ) => FakeAgentStep | Promise<FakeAgentStep>;

  constructor(
    repoDir: string,
    script: (ctx: FakeAgentContext) => FakeAgentStep | Promise<FakeAgentStep>,
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
      const step = await this.script({
        stage: options.stage,
        branch: options.branch,
        dir: worktree,
        signal: options.signal,
        idleSeconds: options.idleSeconds,
        wallClockMs: options.wallClockMs,
        ...(options.model ? { model: options.model } : {}),
        context: (file) => {
          const path = join(options.ctxDir, file);
          return existsSync(path) ? readFileSync(path, "utf8") : undefined;
        },
      });
      for (const line of step.rawLines ?? []) options.onRawLine?.(line);
      for (const [path, content] of Object.entries(step.files ?? {})) {
        mkdirSync(dirname(join(worktree, path)), { recursive: true });
        writeFileSync(join(worktree, path), content);
      }
      for (const path of step.remove ?? [])
        rmSync(join(worktree, path), { force: true });
      if (
        Object.keys(step.files ?? {}).length > 0 ||
        (step.remove?.length ?? 0) > 0
      ) {
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
      if (options.signal?.aborted) {
        return {
          commits: [],
          error: "aborted: the job was lost",
          errorKind: "other",
          durationMs,
        };
      }
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
  readonly placements: (SandboxPlacement | undefined)[] = [];
  private readonly repoDir: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
  }

  async open(
    ref: string,
    placement?: SandboxPlacement,
  ): Promise<SandboxSession> {
    this.opened.push(ref);
    this.placements.push(placement);
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
          env: { ...process.env, ...placement?.env }, // what docker({ env }) sets inside the container
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

// A docker that only writes down what it is asked and answers like a compose host would: a project that has been
// brought up has a default network until it is taken down. Counts the projects that are up at the same time.
export class FakeDocker {
  readonly calls: string[][] = [];
  // projects left behind by a worker that stopped: they show in `ps -a`
  orphans: string[] = [];
  // the first `compose down` of a project leaves its network, as it does with a sandbox still attached
  leaveNetworkAfterDown = false;
  // answers a call by itself instead of the usual way; undefined lets the usual way answer
  answer: (args: string[]) => Partial<DockerResult> | undefined = () =>
    undefined;
  upDelayMs = 0; // how long `compose up` takes
  active = 0;
  maxActive = 0;
  private readonly up = new Set<string>();
  private readonly networks = new Set<string>();

  readonly cli: DockerCli = async (args) => {
    this.calls.push(args);
    const custom = this.answer(args);
    const reply = (stdout: string, code = 0): DockerResult => ({
      code,
      out: stdout,
      stdout,
    });
    if (custom) {
      const out = custom.out ?? custom.stdout ?? "";
      return { code: 0, out, stdout: out, ...custom };
    }
    const project = args[0] === "compose" ? args[2] : undefined;
    if (project && args.includes("up") && !args.includes("down")) {
      this.up.add(project);
      this.active = this.up.size;
      this.maxActive = Math.max(this.maxActive, this.active);
      if (this.upDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.upDelayMs));
      this.networks.add(project);
    }
    if (project && args.includes("down")) {
      this.up.delete(project);
      this.active = this.up.size;
      if (this.leaveNetworkAfterDown) this.leaveNetworkAfterDown = false;
      else this.networks.delete(project);
    }
    if (args[0] === "network" && args[1] === "ls") {
      const label = args.find((a) =>
        a.startsWith("label=com.docker.compose.project="),
      );
      const project = label?.split("=").at(-1) ?? "";
      return reply(this.networks.has(project) ? `${project}_default` : "");
    }
    if (args[0] === "ps")
      return reply([...this.orphans, ...this.up].join("\n"));
    return reply("");
  };

  // The calls that start with these words.
  only(...words: string[]): string[][] {
    return this.calls.filter((call) => words.every((w, i) => call[i] === w));
  }
}
