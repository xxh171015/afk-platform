// PROTOTYPE — M0 单票流水线：配置与共用工具。M1 的 worker 会复用这里的函数。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const AFK = join(homedir(), ".afk");
export const REPO = process.env.M0_REPO ?? join(AFK, "repos", "afk-pilot-backend");
export const IMAGE = process.env.M0_IMAGE ?? "sandcastle:afk-pilot-backend";
export const MODEL = process.env.M0_MODEL ?? "auto";
export const SKILLS_SHA = "5beb35b";
export const SKILLS_MOUNT = join(AFK, `skills@${SKILLS_SHA}`, "skills", "engineering");
export const PROTECTED = [".sandcastle/", ".github/", "vitest.config.", "tsconfig.json", "openapi/openapi.yaml"];
export const REMOTE = "origin";

export const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const secrets = existsSync(join(AFK, "env")) ? loadEnvFile(join(AFK, "env")) : {};
export const CURSOR_API_KEY = secrets.CURSOR_API_KEY ?? "";
const GITHUB_TOKEN = secrets.GITHUB_TOKEN ?? "";

export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, env: opts.env ?? process.env, input: opts.input, maxBuffer: 64 << 20 });
  let out = (r.stdout ?? "") + (r.stderr ?? "");
  for (const secret of [GITHUB_TOKEN, CURSOR_API_KEY, Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")]) {
    if (secret) out = out.split(secret).join("***");
  }
  return { code: r.status ?? -1, out, stdout: r.stdout ?? "" };
}

const COMMITTER = { GIT_COMMITTER_NAME: "afk-worker", GIT_COMMITTER_EMAIL: "afk-worker@users.noreply.github.com" };
export const git = (args: string[], cwd = REPO, env: Record<string, string> = {}) =>
  sh("git", args, { cwd, env: { ...process.env, ...COMMITTER, ...env } });
export const gitOut = (args: string[], cwd = REPO) => git(args, cwd).stdout.trim();

/** 推送凭据只在 worker 进程里：通过 extraheader 传，不写进 .git/config，也不出现在 URL 里 */
export function push(args: string[]) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`;
  return git(["-c", `http.extraHeader=${header}`, "push", ...args]);
}

export type StageEvent = { stage: string; detail?: string; ms: number; ok: boolean };
export const timeline: StageEvent[] = [];
export const notes: string[] = [];
export const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
export async function timed<T>(stage: string, fn: () => Promise<T>, okOf: (r: T) => boolean = () => true, detailOf: (r: T) => string = () => ""): Promise<T> {
  const t = Date.now();
  log(`▶ ${stage}`);
  try {
    const r = await fn();
    timeline.push({ stage, detail: detailOf(r), ms: Date.now() - t, ok: okOf(r) });
    return r;
  } catch (e) {
    timeline.push({ stage, detail: `抛错 ${String(e).slice(0, 200)}`, ms: Date.now() - t, ok: false });
    throw e;
  }
}
export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------- 结构化输出 schema ----------
export const ImplementResult = z.object({
  status: z.enum(["done", "cannot-proceed"]),
  reason: z.string().optional(),
  summary: z.string(),
  acceptance: z.record(z.string(), z.array(z.string())),
  uncertainties: z.array(z.string()),
});
export const ReviewResult = z.object({
  verdict: z.enum(["pass", "fix"]),
  mustFix: z.array(z.object({ file: z.string(), line: z.number().optional(), problem: z.string() })),
  suggestions: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
