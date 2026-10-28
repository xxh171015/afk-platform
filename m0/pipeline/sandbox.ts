// PROTOTYPE — 平台里唯一调用 Sandcastle 的模块（以后要 patch / fork，只改这里）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSandbox, cursor, Output, run, StructuredOutputError } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { z } from "zod";
import { CURSOR_API_KEY, IMAGE, MODEL, REPO, SKILLS_MOUNT, git, gitOut, notes } from "./config.ts";

const provider = (ctxDir?: string) =>
  docker({
    imageName: IMAGE,
    mounts: [
      ...(ctxDir ? [{ hostPath: ctxDir, sandboxPath: "/context", readonly: true }] : []),
      { hostPath: SKILLS_MOUNT, sandboxPath: "/home/agent/.cursor/skills", readonly: true },
    ],
  });

/** Sandcastle 把 worktree 放在 <clone>/.sandcastle/worktrees/<branch 里的 / 换成 ->；中断恢复要在调用前自己处理 */
export const worktreeDir = (branch: string) => join(REPO, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));

/** 准备：复用 worktree 前，未提交的改动先存 diff 再丢弃（Sandcastle 不会替我们丢） */
export function discardUncommitted(branch: string, saveTo: string): string {
  const dir = worktreeDir(branch);
  if (!existsSync(dir)) return "无 worktree";
  const dirty = git(["status", "--porcelain"], dir).stdout.trim();
  if (!dirty) return "worktree 干净";
  writeFileSync(saveTo, git(["diff", "HEAD"], dir).stdout + "\n--- untracked ---\n" + dirty);
  git(["reset", "--hard"], dir);
  git(["clean", "-fd"], dir);
  return `丢弃了未提交改动，diff 存到 ${saveTo}`;
}

export type AgentRunOptions<T extends z.ZodType> = {
  stage: string;
  branch: string;
  baseBranch: string;
  prompt: string; // prompt 文件的绝对路径
  schema: T;
  ctxDir: string;
  outDir: string;
  idleSeconds?: number;
  wallClockMs?: number;
  /** 把 Cursor CLI 的原始事件行（含 usage 之类）存下来 */
  onRaw?: (line: string) => void;
};
export type AgentRunResult<T extends z.ZodType> = {
  output?: z.infer<T>;
  commits: string[];
  error?: string; // 结构化输出不合法、超时等
  errorKind?: "invalid-output" | "timeout" | "other";
  stdout: string;
  sessionId?: string;
  ms: number;
};

export async function agentRun<T extends z.ZodType>(o: AgentRunOptions<T>): Promise<AgentRunResult<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("wall-clock")), o.wallClockMs ?? 30 * 60_000);
  const t = Date.now();
  try {
    const r = await run({
      agent: cursor(MODEL, { env: { CURSOR_API_KEY } }),
      sandbox: provider(o.ctxDir),
      cwd: REPO,
      branchStrategy: { type: "branch", branch: o.branch, baseBranch: o.baseBranch },
      promptFile: resolve(o.prompt),
      output: Output.object({ tag: "result", schema: o.schema }),
      idleTimeoutSeconds: o.idleSeconds ?? 600,
      signal: ac.signal,
      logging: {
        type: "file",
        path: join(o.outDir, `${o.stage}.log`),
        verbose: true,
        onAgentStreamEvent: (e) => {
          if (e.type === "raw") {
            appendFileSync(join(o.outDir, `${o.stage}.stream.jsonl`), e.line + "\n");
            o.onRaw?.(e.line);
          }
        },
      },
    });
    return { output: r.output, commits: r.commits.map((c) => c.sha), stdout: r.stdout, sessionId: r.iterations[0]?.sessionId, ms: Date.now() - t };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 400) : String(e);
    const kind = e instanceof StructuredOutputError ? "invalid-output" : /Idle|wall-clock|timeout/i.test(name + msg) ? "timeout" : "other";
    return {
      commits: e instanceof StructuredOutputError ? e.commits.map((c) => c.sha) : [],
      error: msg,
      errorKind: kind,
      stdout: "",
      ms: Date.now() - t,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type StepResult = { name: string; exitCode: number; ms: number; log: string };
/** 在全新沙箱里跑一组命令（门禁用）。命令用 timeout 包住，因为 sandbox.exec 没有超时。返回 junit 原文 */
export async function execInFreshSandbox(opts: {
  branch: string;
  steps: { name: string; run: string; timeoutSeconds: number }[];
  junitPath?: string;
  probe?: boolean;
}): Promise<{ steps: StepResult[]; junit?: string; probe?: Record<string, string> }> {
  const sb = await createSandbox({ branch: opts.branch, sandbox: provider(), cwd: REPO });
  const steps: StepResult[] = [];
  let probe: Record<string, string> | undefined;
  try {
    for (const s of opts.steps) {
      const t = Date.now();
      const r = await sb.exec(`timeout ${s.timeoutSeconds} ${s.run}`);
      steps.push({ name: s.name, exitCode: r.exitCode, ms: Date.now() - t, log: r.stdout + r.stderr });
      if (r.exitCode !== 0) break;
    }
    if (opts.probe) {
      probe = {};
      const cmds: Record<string, string> = {
        gitCommonDir: "git rev-parse --git-common-dir",
        commonDirWritable: 'test -w "$(git rev-parse --git-common-dir)" && echo yes || echo no',
        canCreateBranch: "git branch zz-probe-branch && git branch -D zz-probe-branch && echo yes || echo no",
        canWriteConfig: 'git config --local zz.probe 1 && git config --local --unset zz.probe && echo yes || echo no',
        canWriteHooks: 'mkdir -p "$(git rev-parse --git-common-dir)/hooks" && touch "$(git rev-parse --git-common-dir)/hooks/zz-probe" && rm "$(git rev-parse --git-common-dir)/hooks/zz-probe" && echo yes || echo no',
        canUpdateOtherRef: 'git update-ref refs/heads/zz-probe-ref HEAD && git update-ref -d refs/heads/zz-probe-ref && echo yes || echo no',
        hasGithubCreds: 'env | grep -c -i -E "github_token|gh_token" || true',
      };
      for (const [k, c] of Object.entries(cmds)) {
        const r = await sb.exec(c);
        probe[k] = (r.stdout + r.stderr).trim().slice(0, 200);
      }
    }
    const junit = opts.junitPath && existsSync(join(sb.worktreePath, opts.junitPath)) ? readFileSync(join(sb.worktreePath, opts.junitPath), "utf8") : undefined;
    return { steps, junit, probe };
  } finally {
    const closed = await sb.close();
    if (closed.preservedWorktreePath) notes.push(`${opts.branch}：沙箱关闭时 worktree 有未提交改动，保留在 ${closed.preservedWorktreePath}`);
    void gitOut;
  }
}
