// PROTOTYPE — 一次性脚本，不进 main。
// 回答的问题：M0 第一天四项验证能不能在 Mac 上全部通过。
//   1. Cursor Agent CLI 在 Sandcastle 的 docker 沙箱里跑完一次 implement 并 commit，不卡在信任提示上
//   2. agent 能加载 skills，或按路径读 SKILL.md 并照着做
//   3. cursor provider 下 Output.object 能取到通过 zod 校验的结构化输出
//   4. 门禁命令能在沙箱里跑，JUnit 结果能拿回宿主机
//
// 用法：见 README.md。只用一张票（试点仓库的 T-001），一次 agent 运行。
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSandbox, cursor, Output, run, StructuredOutputError } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------- 配置 ----------
const AFK = join(homedir(), ".afk");
const REPO = process.env.M0_REPO ?? join(AFK, "repos", "afk-pilot-backend");
const IMAGE = process.env.M0_IMAGE ?? "sandcastle:afk-pilot-backend";
// "auto" 是 Cursor 当前的默认模型 slug；不确定时先看报告里 `agent models` 的输出
const MODEL = process.env.M0_MODEL ?? "auto";
const SKILLS_SHA = "5beb35b";
const SKILLS_DIR = join(AFK, `skills@${SKILLS_SHA}`);
const BASELINE = { tests: Number(process.env.M0_BASELINE_TESTS ?? 17), skipped: 0 };
const PROTECTED = [".sandcastle/", ".github/", "vitest.config.", "tsconfig.json", "openapi/openapi.yaml"];
const WALL_CLOCK_MS = 30 * 60_000;

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const runId = `m0d1-${stamp}`;
const OUT = join(AFK, "m0-day-one", runId);
const CTX = join(AFK, "context", runId);
const SPEC_BRANCH = `spec/m0d1-${stamp}`;
const AGENT_BRANCH = `agent/T-001-${stamp}`;
mkdirSync(OUT, { recursive: true });
mkdirSync(CTX, { recursive: true });

// ---------- 小工具 ----------
type Check = { name: string; pass: boolean; evidence: string[] };
const checks: Record<string, Check> = {
  c1: { name: "1 Cursor 在沙箱里跑完 implement 并 commit，没卡在信任提示", pass: false, evidence: [] },
  c2: { name: "2 skills：自动发现，或按路径读 SKILL.md 并照做", pass: false, evidence: [] },
  c3: { name: "3 Output.object 取到通过 zod 校验的结构化输出", pass: false, evidence: [] },
  c4: { name: "4 门禁命令在沙箱里跑，JUnit 拿回宿主机", pass: false, evidence: [] },
};
const notes: string[] = [];
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, env: opts.env ?? process.env });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const git = (args: string[], cwd = REPO) => sh("git", args, { cwd });

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function finish(code: number): never {
  const report = { runId, model: MODEL, image: IMAGE, specBranch: SPEC_BRANCH, agentBranch: AGENT_BRANCH, checks, notes };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n================ 结果 ================");
  for (const c of Object.values(checks)) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    for (const e of c.evidence) console.log(`        - ${e}`);
  }
  if (notes.length) console.log("\n备注：\n" + notes.map((n) => `  - ${n}`).join("\n"));
  console.log(`\n完整报告：${join(OUT, "report.json")}\n日志目录：${OUT}`);
  process.exit(code);
}

// 和 Sandcastle 的规则一致：取最后一个 <tag>…</tag>，去掉可选的 ``` 围栏
function lastTag(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last?.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
}

const ImplementResult = z.object({
  status: z.enum(["done", "cannot-proceed"]),
  reason: z.string().optional(),
  summary: z.string(),
  acceptance: z.record(z.string(), z.array(z.string())),
  uncertainties: z.array(z.string()),
  probe: z.object({ visibleSkills: z.array(z.string()), tddDescription: z.string() }),
});

// ---------- 0 预检 ----------
log("0 预检");
for (const [what, ok] of [
  ["docker 可用", sh("docker", ["info"]).code === 0],
  ["~/.afk/env 存在", existsSync(join(AFK, "env"))],
  [`试点仓库存在：${REPO}`, existsSync(join(REPO, ".git"))],
] as const) {
  if (!ok) {
    notes.push(`预检失败：${what}`);
    finish(2);
  }
}
const secrets = loadEnvFile(join(AFK, "env"));
if (!secrets.CURSOR_API_KEY) {
  notes.push("预检失败：~/.afk/env 里没有 CURSOR_API_KEY");
  finish(2);
}
const CURSOR_ENV = { CURSOR_API_KEY: secrets.CURSOR_API_KEY };

const mt = git(["merge-tree", "--write-tree", "HEAD", "HEAD"]);
notes.push(`git merge-tree --write-tree（在仓库里）：${mt.code === 0 ? "OK" : "FAIL " + mt.out.trim()}`);

git(["fetch", "origin", "main"]);
const baseSha = git(["rev-parse", "origin/main"]).out.trim();
git(["branch", "-f", SPEC_BRANCH, baseSha]); // 集成分支：本地 ref，作为 baseBranch
notes.push(`基准提交 origin/main = ${baseSha.slice(0, 7)}；集成分支 ${SPEC_BRANCH}`);

// skills：固定 SHA，只读挂载
if (!existsSync(SKILLS_DIR)) {
  log(`clone skills 到 ${SKILLS_DIR}`);
  sh("git", ["clone", "-q", "https://github.com/mattpocock/skills.git", SKILLS_DIR]);
  sh("git", ["-C", SKILLS_DIR, "checkout", "-q", SKILLS_SHA]);
}
const SKILLS_MOUNT = join(SKILLS_DIR, "skills", "engineering");
const tddFile = join(SKILLS_MOUNT, "tdd", "SKILL.md");
if (!existsSync(tddFile)) {
  notes.push(`预检失败：找不到 ${tddFile}`);
  finish(2);
}
const realTddDescription = /^description:\s*(.+)$/m.exec(readFileSync(tddFile, "utf8"))?.[1]?.trim() ?? "";

// ---------- 1 镜像 ----------
if (!process.env.M0_SKIP_BUILD) {
  log(`构建镜像 ${IMAGE}（第一次要几分钟）`);
  const uid = String(process.getuid?.() ?? 1000);
  const gid = String(process.getgid?.() ?? 1000);
  const b = sh("docker", [
    "build", "-t", IMAGE, "--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`,
    "-f", join(REPO, ".sandcastle", "Dockerfile"), join(REPO, ".sandcastle"),
  ]);
  writeFileSync(join(OUT, "docker-build.log"), b.out);
  if (b.code !== 0) {
    notes.push(`镜像构建失败，见 ${join(OUT, "docker-build.log")}`);
    finish(2);
  }
}
for (const [label, args] of [["agent --version", ["--version"]], ["agent models", ["models"]]] as const) {
  const r = sh("docker", ["run", "--rm", "--entrypoint", "agent", "-e", "CURSOR_API_KEY", IMAGE, ...args], {
    env: { ...process.env, ...CURSOR_ENV },
  });
  writeFileSync(join(OUT, `preflight-${label.replace(/\W+/g, "-")}.txt`), r.out);
  notes.push(`容器内 ${label}：exit ${r.code}，输出见 preflight-*.txt`);
}

// ---------- 2 渲染 /context ----------
log("渲染 /context");
const ticketPath = join(REPO, "docs", "tickets", "T-001-filter-orders-by-status.md");
writeFileSync(join(CTX, "ticket.md"), readFileSync(ticketPath, "utf8"));
writeFileSync(
  join(CTX, "spec.md"),
  [
    "# M0 第一天验证用的 spec",
    "",
    "给订单列表加一个按状态过滤的查询参数。纯后端，只改 src/orders/ 和 test/。",
    "",
    "## 已确认的 seams（不要再确认）",
    "",
    "- 测试走 HTTP：用 test/helpers.ts 里的 startApp()",
    "- 解析与校验放在 src/orders/，复用 isOrderStatus",
    "- 路由层只负责把校验结果映射成 200 或 400",
    "",
  ].join("\n"),
);
writeFileSync(
  join(CTX, "run.json"),
  JSON.stringify({ stage: "implement", baseSha, branch: AGENT_BRANCH, integrationBranch: SPEC_BRANCH, ticketVersion: 1, idleTimeoutSeconds: 600 }, null, 2),
);

// ---------- 3 implement（检查 1、2、3） ----------
const provider = () =>
  docker({
    imageName: IMAGE,
    mounts: [
      { hostPath: CTX, sandboxPath: "/context", readonly: true },
      { hostPath: SKILLS_MOUNT, sandboxPath: "/home/agent/.cursor/skills", readonly: true },
    ],
  });

const streamEvents: { type: string; iteration?: number; timestamp?: unknown }[] = [];
const rawLines: string[] = [];
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(new Error("wall-clock 30min")), WALL_CLOCK_MS);

log(`implement：模型 ${MODEL}，分支 ${AGENT_BRANCH}（基于 ${SPEC_BRANCH}）`);
const t0 = Date.now();
let output: z.infer<typeof ImplementResult> | undefined;
let stdout = "";
let commits: { sha: string }[] = [];
let runError: unknown;
try {
  const r = await run({
    agent: cursor(MODEL, { env: CURSOR_ENV }),
    sandbox: provider(),
    cwd: REPO,
    branchStrategy: { type: "branch", branch: AGENT_BRANCH, baseBranch: SPEC_BRANCH },
    promptFile: resolve(import.meta.dirname, "prompts", "afk-implement.md"),
    output: Output.object({ tag: "result", schema: ImplementResult }),
    idleTimeoutSeconds: 600,
    signal: ac.signal,
    logging: {
      type: "file",
      path: join(OUT, "agent.log"),
      verbose: true,
      onAgentStreamEvent: (e) => {
        streamEvents.push({ type: e.type });
        if (e.type === "raw") {
          rawLines.push(e.line);
          appendFileSync(join(OUT, "stream-raw.jsonl"), e.line + "\n");
        }
        if (e.type === "toolCall") log(`  tool: ${e.name}`);
      },
    },
  });
  output = r.output;
  stdout = r.stdout;
  commits = [...r.commits];
  notes.push(`implement 用时 ${Math.round((Date.now() - t0) / 1000)}s，iterations=${r.iterations.length}，sessionId=${r.iterations[0]?.sessionId ?? "无"}`);
  notes.push(`IterationResult.usage = ${JSON.stringify(r.iterations[0]?.usage ?? null)}`);
} catch (e) {
  runError = e;
  const name = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  checks.c1!.evidence.push(`run() 抛错：${name.slice(0, 300)}`);
  if (e instanceof StructuredOutputError) {
    stdout = "";
    commits = [...e.commits];
    checks.c3!.evidence.push(`StructuredOutputError，rawMatched=${JSON.stringify(e.rawMatched)?.slice(0, 400)}，cause=${String(e.cause).slice(0, 300)}`);
  }
} finally {
  clearTimeout(timer);
}
writeFileSync(join(OUT, "stdout.txt"), stdout);

// 检查 1：有 commit，没抛错（卡住的话会被 600 秒空闲超时兜住并抛错）
const branchLog = git(["log", "--oneline", `${SPEC_BRANCH}..${AGENT_BRANCH}`]).out.trim();
checks.c1!.evidence.push(`SDK 返回 ${commits.length} 个 commit；分支上相对集成分支的提交：${branchLog ? "\n" + branchLog.split("\n").map((l) => "            " + l).join("\n") : "无"}`);
checks.c1!.evidence.push(`流事件：${streamEvents.length} 个（日志 ${join(OUT, "agent.log")}）`);
checks.c1!.pass = runError === undefined && commits.length > 0 && branchLog !== "";
if (runError instanceof StructuredOutputError && branchLog !== "") {
  checks.c1!.pass = true; // agent 跑完并提交了，只是输出格式不对：归检查 3
}

// 检查 3：Output.object；再用 worker 自己的提取逻辑对照（方案 B 的备选路径）
checks.c3!.pass = output !== undefined;
if (output) checks.c3!.evidence.push(`status=${output.status}，summary=${output.summary.slice(0, 80)}`);
const own = stdout ? lastTag(stdout, "result") : undefined;
if (own) {
  try {
    ImplementResult.parse(JSON.parse(own));
    notes.push("自己从 stdout 取最后一个 <result> 并用 zod 校验：成功（方案 B 的备选路径可用）");
  } catch (e) {
    notes.push(`自己从 stdout 取 <result> 并校验：失败 ${String(e).slice(0, 160)}`);
  }
} else if (stdout) {
  notes.push("stdout 里没有找到 <result> 标签");
}

// 检查 2：自动发现（不读文件就能列出 tdd）+ 按路径读（description 一字不差）
if (output) {
  const visible = output.probe.visibleSkills;
  const auto = visible.some((s) => s.toLowerCase().includes("tdd"));
  const byPath = output.probe.tddDescription.trim() === realTddDescription;
  checks.c2!.evidence.push(`自动发现（不读文件就能看到 tdd）：${auto ? "是" : "否"}；可见技能：${visible.slice(0, 12).join(", ") || "无"}`);
  checks.c2!.evidence.push(`按路径读 SKILL.md（description 一字不差）：${byPath ? "是" : "否"}`);
  checks.c2!.evidence.push(`agent 声明的验收标准→测试：${JSON.stringify(output.acceptance).slice(0, 300)}`);
  checks.c2!.pass = auto || byPath;
} else {
  checks.c2!.evidence.push("没有结构化输出，无法判断（先解决检查 3）");
}

// 用量字段：从原始 stream-json 里找
const usageHits = rawLines.filter((l) => /usage|tokens/i.test(l)).slice(0, 2);
notes.push(
  usageHits.length
    ? `stream-json 里含 usage/tokens 的行（前 2 条，截断）：${usageHits.map((l) => l.slice(0, 300)).join(" | ")}`
    : "stream-json 里没有找到 usage / tokens 字段",
);

// ---------- 4 门禁（检查 4） ----------
if (commits.length > 0 || branchLog !== "") {
  log("门禁：另起新沙箱跑");
  const gates = parseYaml(git(["show", `${baseSha}:.sandcastle/gates.yaml`]).out) as {
    setup?: string;
    commands: { name: string; run: string; timeoutSeconds: number; junit?: string }[];
  };
  const diff = git(["diff", "--name-only", `${baseSha}...${AGENT_BRANCH}`]).out.trim().split("\n").filter(Boolean);
  const touched = diff.filter((f) => PROTECTED.some((p) => f.startsWith(p)));
  checks.c4!.evidence.push(`改动文件 ${diff.length} 个；碰到保护路径：${touched.length ? touched.join(", ") : "无"}`);

  const sb = await createSandbox({ branch: AGENT_BRANCH, sandbox: provider(), cwd: REPO });
  try {
    let allZero = true;
    const steps: { name: string; run: string; timeout: number }[] = [];
    if (gates.setup) steps.push({ name: "setup", run: gates.setup, timeout: 600 });
    for (const c of gates.commands) steps.push({ name: c.name, run: c.run, timeout: c.timeoutSeconds });
    for (const s of steps) {
      const t = Date.now();
      const r = await sb.exec(`timeout ${s.timeout} ${s.run}`);
      writeFileSync(join(OUT, `gate-${s.name}.log`), r.stdout + r.stderr);
      checks.c4!.evidence.push(`${s.name}：exit ${r.exitCode}，${Math.round((Date.now() - t) / 1000)}s（日志 gate-${s.name}.log）`);
      if (r.exitCode !== 0) allZero = false;
    }
    const junitRel = gates.commands.find((c) => c.junit)?.junit ?? "reports/junit.xml";
    const junitPath = join(sb.worktreePath, junitRel);
    if (existsSync(junitPath)) {
      const xml = readFileSync(junitPath, "utf8");
      writeFileSync(join(OUT, "junit.xml"), xml);
      const total = Number(/<testsuites[^>]*\btests="(\d+)"/.exec(xml)?.[1] ?? NaN);
      const skipped = [...xml.matchAll(/<testsuite\s[^>]*\bskipped="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
      const okCount = total >= BASELINE.tests && skipped <= BASELINE.skipped;
      checks.c4!.evidence.push(`JUnit 已在宿主机读到：tests=${total}，skipped=${skipped}（基线 ${BASELINE.tests}/${BASELINE.skipped}，${okCount ? "不比基线差" : "比基线差"}）`);
      checks.c4!.pass = allZero && okCount;
    } else {
      checks.c4!.evidence.push(`宿主机上找不到 ${junitPath}`);
    }
  } finally {
    const closed = await sb.close();
    if (closed.preservedWorktreePath) notes.push(`门禁沙箱关闭时 worktree 有未提交改动，保留在 ${closed.preservedWorktreePath}`);
  }
} else {
  checks.c4!.evidence.push("agent 没有产生 commit，跳过门禁");
}

const allPass = Object.values(checks).every((c) => c.pass);
finish(allPass ? 0 : 1);
