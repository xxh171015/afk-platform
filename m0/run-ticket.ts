// PROTOTYPE — M0 完整单票流水线：把一张票无人值守地合进集成分支。
// 用法见 README.md。每个阶段是 pipeline/stages.ts 里的一个函数，M1 的 worker 会复用它们。
//
//   准备 → implement → 补 trailer 并推送 → 保护路径 → 门禁 → review → merge-tree 候选
//        → 候选门禁 → --force-with-lease 前移 spec 分支
//   失败时：gate-fix / review-fix / merge-fix 各最多一次，再失败就 blocked 并带原因码。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AFK, CURSOR_API_KEY, ImplementResult, MODEL, REMOTE, REPO, ReviewResult, git, gitOut, log, notes, push, stamp, timed, timeline,
} from "./pipeline/config.ts";
import { agentRun, discardUncommitted } from "./pipeline/sandbox.ts";
import {
  mergeCandidate, protectedPathsTouched, renderContext, runGate, rememberGate, stampTrailers, hasRef,
  type GateResult, type Ids,
} from "./pipeline/stages.ts";

// ---------- 参数 ----------
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => args[args.indexOf(`--${n}`) + 1];
const ticketKey = opt("ticket") ?? "T-001";
const SABOTAGE = flag("sabotage"); // implement 之后故意提交一个 tsc 错误，用来走 gate-fix
const APPROVE_PROTECTED = flag("approve-protected");
const PROBE = flag("probe-git"); // 顺便探测沙箱里主 clone 的 .git 是否可写
const specBranch = opt("spec") ?? `spec/m0p-${stamp}`;

const runId = `m0p-${stamp}-${ticketKey}`;
const OUT = join(AFK, "m0-pipeline", runId);
mkdirSync(OUT, { recursive: true });
const ids: Ids = { spec: "S-M0", ticket: ticketKey, run: runId };
const agentBranch = `agent/${ticketKey}-${stamp}`;
const gateBranch = `gate/${ticketKey}-${stamp}`;
const HERE = import.meta.dirname;
const prompt = (n: string) => resolve(HERE, "prompts", `${n}.md`);

type Outcome = { state: "done" | "blocked"; reason?: string; detail?: string };
let agentRuns = 0;
const usageHits: string[] = [];

function finish(o: Outcome): never {
  notes.push(usageHits.length ? `stream-json 里疑似 usage 的行（前 2 条）：${usageHits.join(" | ")}` : "stream-json 里没有找到 usage / inputTokens 字段");
  const report = { runId, ticket: ticketKey, model: MODEL, specBranch, agentBranch, outcome: o, agentRuns, timeline, notes };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n================ 结果 ================");
  console.log(o.state === "done" ? `DONE  ${ticketKey} 已合进 ${specBranch}` : `BLOCKED  ${ticketKey}：${o.reason}${o.detail ? "\n        " + o.detail : ""}`);
  console.log("\n时间线：");
  for (const e of timeline) console.log(`  ${e.ok ? "ok  " : "FAIL"} ${String(Math.round(e.ms / 1000)).padStart(4)}s  ${e.stage}${e.detail ? "  — " + e.detail : ""}`);
  console.log(`\nagent 运行次数：${agentRuns}（上限 5）`);
  if (notes.length) console.log("\n备注：\n" + notes.map((n) => `  - ${n}`).join("\n"));
  console.log(`\n完整报告：${join(OUT, "report.json")}\n日志目录：${OUT}`);
  process.exit(o.state === "done" ? 0 : 1);
}
const blocked = (reason: string, detail?: string): never => finish({ state: "blocked", reason, ...(detail ? { detail } : {}) });

// ---------- 0 预检与基线 ----------
const ticketFile = (() => readdirTicket(ticketKey))();
function readdirTicket(key: string): string {
  git(["fetch", REMOTE, "main"]);
  const f = gitOut(["ls-tree", "--name-only", `${REMOTE}/main`, "docs/tickets/"]).split("\n").find((n) => n.startsWith(`docs/tickets/${key}-`));
  if (!f) throw new Error(`找不到票 ${key}（在 ${REMOTE}/main:docs/tickets/）`);
  return gitOut(["show", `${REMOTE}/main:${f}`]);
}
if (!CURSOR_API_KEY) throw new Error("~/.afk/env 里没有 CURSOR_API_KEY");

git(["fetch", REMOTE, "main"]);
const mainSha = gitOut(["rev-parse", `${REMOTE}/main`]);
if (!hasRef(specBranch)) {
  git(["branch", specBranch, mainSha]);
  const p = push([REMOTE, `${specBranch}:refs/heads/${specBranch}`]);
  notes.push(`创建并推送集成分支 ${specBranch} @ ${mainSha.slice(0, 7)}：${p.code === 0 ? "ok" : "失败 " + p.out.slice(0, 200)}`);
}
let specHead = gitOut(["rev-parse", specBranch]);
let currentBaseline: GateResult | undefined;

{
  // 基线门禁：集成分支当前 head 的 GateResult，后面所有"不比基线差"的比较都用它
  const gb = `gate/baseline-${stamp}`;
  git(["branch", "-f", gb, specHead]);
  const { result } = await timed("基线门禁（集成分支 head）", () => runGate({ branch: gb, configSha: specHead, outDir: OUT, label: "baseline" }), (r) => r.result.pass, (r) => `tests=${r.result.tests} skipped=${r.result.skipped}`);
  git(["branch", "-D", gb]);
  if (!result.pass) blocked("baseline-failed", result.reasons.join("; "));
  rememberGate(specHead, result);
  currentBaseline = result;
}

// ---------- 阶段函数：一次 agent 运行 ----------
async function agentStage(stage: "implement" | "gate-fix" | "review-fix" | "merge-fix", extra: { failure?: string; reviewJson?: unknown } = {}) {
  agentRuns++;
  const label = `${stage}#${agentRuns}`;
  const ctxDir = join(AFK, "context", `${runId}-${label.replace("#", "-")}`);
  const mergeBase = git(["merge-base", specBranch, agentBranch]).code === 0 ? gitOut(["merge-base", specBranch, agentBranch]) : specHead;
  renderContext({
    dir: ctxDir,
    ticketMd: ticketFile,
    specMd: `# M0 流水线验证用的 spec\n\n试点后端的小改动，纯后端，只改 src/ 和 test/。\n\n## 已确认的 seams（不要再确认）\n\n- 测试走 HTTP：用 test/helpers.ts 里的 startApp()\n- 解析与校验放在 src/orders/，路由层只做映射\n`,
    runJson: { stage, baseSha: mergeBase, branch: agentBranch, integrationBranch: specBranch, ticket: ticketKey, idleTimeoutSeconds: 600 },
    ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
    ...(extra.reviewJson !== undefined ? { reviewJson: extra.reviewJson } : {}),
  });
  const before = hasRef(agentBranch) ? gitOut(["rev-parse", agentBranch]) : specHead;
  const prep = discardUncommitted(agentBranch, join(OUT, `${label}-discarded.diff`));
  const r = await timed(
    `${label}（agent，新会话）`,
    () => agentRun({ stage: label.replace("#", "-"), branch: agentBranch, baseBranch: specBranch, prompt: prompt(stage === "implement" ? "implement" : "fix"), schema: ImplementResult, ctxDir, outDir: OUT, onRaw: (l) => { if (usageHits.length < 2 && /"usage"|"inputTokens"|"input_tokens"/.test(l)) usageHits.push(l.slice(0, 300)); } }),
    (x) => !x.error && x.output?.status === "done",
    (x) => `${x.error ? x.error.slice(0, 120) : `status=${x.output?.status}`}；prep：${prep}`,
  );
  const after = hasRef(agentBranch) ? gitOut(["rev-parse", agentBranch]) : before;
  return { r, before, after, newCommits: before === after ? 0 : Number(gitOut(["rev-list", "--count", `${before}..${after}`])) };
}

/** 阶段 2：agent 运行后的出口检查，对应设计里 chk 菱形 */
function checkAgentOutcome(x: Awaited<ReturnType<typeof agentStage>>): void {
  if (x.r.errorKind === "invalid-output") blocked("invalid-output", x.r.error);
  if (x.r.errorKind === "timeout") blocked("timeout", x.r.error);
  if (x.r.error) blocked("agent-error", x.r.error);
  const o = x.r.output!;
  if (o.status === "cannot-proceed") blocked(/contract/i.test(o.reason ?? "") ? "contract-change-needed" : "agent-gave-up", o.reason);
  if (x.newCommits === 0) blocked("no-commits", "运行结束但分支上没有新 commit");
}

/** 阶段 3：补 trailer 并推送 */
async function stampAndPush(before: string, tag: string) {
  const tmp = join(AFK, "tmp-stamp", `${runId}-${tag}`);
  const s = await timed(`补 trailer（${tag}）`, async () => stampTrailers(agentBranch, before, ids, tmp), (x) => !x.error, (x) => `重写 ${x.rewritten} 个 commit；Cursor 自带 trailer：${x.cursorTrailer ? "有" : "无"}${x.error ? "；" + x.error : ""}`);
  if (s.error) blocked("stamp-failed", s.error);
  const trailers = gitOut(["log", "-1", "--format=%B", agentBranch]).split("\n").filter((l) => /^(Spec|Ticket|Run|Made-with|Co-authored)/i.test(l));
  notes.push(`${tag}：最新 commit 的 trailer = ${JSON.stringify(trailers)}`);
  const p = await timed(`推送 ${agentBranch}`, async () => push(["--force", REMOTE, `${agentBranch}:refs/heads/${agentBranch}`]), (x) => x.code === 0, (x) => (x.code === 0 ? "" : x.out.slice(0, 160)));
  if (p.code !== 0) blocked("push-failed", p.out.slice(0, 300));
}

// ---------- 主流程 ----------
let fixes = { gate: 0, review: 0, merge: 0 };
let reviewed = false;
let reviewJson: unknown;

// 2 implement
let step = await agentStage("implement");
checkAgentOutcome(step);
notes.push(`implement 的 summary：${step.r.output!.summary.slice(0, 160)}`);
await stampAndPush(step.before, "implement");

if (SABOTAGE) {
  // 故意制造一个真实的、可修的门禁失败：在 src 里加一个 tsc 类型错误
  const tmp = join(AFK, "tmp-stamp", `${runId}-sabotage`);
  git(["worktree", "add", tmp, agentBranch]);
  const f = join(tmp, "src", "orders", "format.ts");
  appendFileSync(f, '\nexport const zzSabotage: number = "not a number";\n');
  git(["add", "-A"], tmp);
  git(["-c", "user.name=m0-sabotage", "-c", "user.email=m0@example.invalid", "commit", "-q", "-m", "Sabotage: add a deliberate type error (M0 gate-fix test)"], tmp);
  git(["worktree", "remove", "--force", tmp]);
  notes.push("--sabotage：已在 agent 分支上加了一个故意的 tsc 错误，用来走 gate-fix");
}

let lastStamped = gitOut(["rev-parse", agentBranch]);

for (let guard = 0; guard < 12; guard++) {
  const base = gitOut(["merge-base", specBranch, agentBranch]);

  // 4a 保护路径
  const pp = protectedPathsTouched(base, agentBranch);
  notes.push(`保护路径检查：改了 ${pp.files.length} 个文件，碰到 ${pp.touched.length ? pp.touched.join(", ") : "无"}`);
  if (pp.touched.length && !APPROVE_PROTECTED) blocked("protected-path-changed", pp.touched.join(", "));

  // 4b 门禁（配置取自基准提交，不取自 agent 分支）
  const g = await timed("单票门禁", () => runGate({ branch: agentBranch, configSha: base, ...(currentBaseline ? { baseline: currentBaseline } : {}), outDir: OUT, label: `single-${guard}`, probe: PROBE && guard === 0 }), (x) => x.result.pass, (x) => `tests=${x.result.tests} skipped=${x.result.skipped}${x.result.pass ? "" : "；" + x.result.reasons.join("; ")}`);
  if (g.probe) {
    writeFileSync(join(OUT, "git-probe.json"), JSON.stringify(g.probe, null, 2));
    notes.push(`沙箱里的 .git 探测：${JSON.stringify(g.probe)}`);
  }
  if (!g.result.pass) {
    if (fixes.gate >= 1) blocked("gate-failed", g.result.reasons.join("; "));
    fixes.gate++;
    step = await agentStage("gate-fix", { failure: g.result.failureLog });
    checkAgentOutcome(step);
    await stampAndPush(step.before, "gate-fix");
    lastStamped = gitOut(["rev-parse", agentBranch]);
    continue;
  }

  // 5 review（只跑一次）
  if (!reviewed) {
    reviewed = true;
    agentRuns++;
    const label = `review#${agentRuns}`;
    const ctxDir = join(AFK, "context", `${runId}-${label.replace("#", "-")}`);
    renderContext({ dir: ctxDir, ticketMd: ticketFile, specMd: "(review 不需要 spec)\n", runJson: { stage: "review", baseSha: base, branch: agentBranch, ticket: ticketKey } });
    const rv = await timed(`${label}（agent，新会话）`, () => agentRun({ stage: label.replace("#", "-"), branch: agentBranch, baseBranch: specBranch, prompt: prompt("review"), schema: ReviewResult, ctxDir, outDir: OUT }), (x) => !x.error, (x) => (x.error ? x.error.slice(0, 120) : `verdict=${x.output?.verdict} mustFix=${x.output?.mustFix.length}`));
    if (rv.error) blocked(rv.errorKind === "invalid-output" ? "invalid-output" : rv.errorKind === "timeout" ? "timeout" : "agent-error", rv.error);
    const review = rv.output!;
    if (rv.commits.length) notes.push(`警告：review 运行产生了 ${rv.commits.length} 个 commit（review 不该改代码）`);
    notes.push(`review：verdict=${review.verdict}，mustFix ${review.mustFix.length} 条，suggestions ${review.suggestions.length} 条`);
    reviewJson = review;
    if (review.verdict === "fix") {
      fixes.review++;
      step = await agentStage("review-fix", { reviewJson: review });
      checkAgentOutcome(step);
      await stampAndPush(step.before, "review-fix");
      lastStamped = gitOut(["rev-parse", agentBranch]);
      continue; // 回到 4a / 4b，再往下合并，不再跑第二次 review
    }
  }

  // 6 合并候选
  const mc = mergeCandidate(specBranch, agentBranch, `Merge ${agentBranch} into ${specBranch}\n\nSpec: ${ids.spec}\nTicket: ${ids.ticket}\nRun: ${ids.run}`);
  notes.push(`merge-tree：${mc.conflict ? "有冲突" : "无冲突，候选 " + mc.candidate!.slice(0, 7)}`);
  let mergeProblem: string | undefined = mc.conflict ? "merge-conflict" : undefined;
  let candidateGate: GateResult | undefined;

  if (!mc.conflict) {
    // 7 候选门禁：在 gate/<ticket> 上跑，配置取集成分支当前 head
    git(["branch", "-f", gateBranch, mc.candidate!]);
    const cg = await timed("候选门禁（合并后）", () => runGate({ branch: gateBranch, configSha: specHead, ...(currentBaseline ? { baseline: currentBaseline } : {}), outDir: OUT, label: `candidate-${guard}` }), (x) => x.result.pass, (x) => `tests=${x.result.tests} skipped=${x.result.skipped}${x.result.pass ? "" : "；" + x.result.reasons.join("; ")}`);
    git(["branch", "-D", gateBranch]);
    candidateGate = cg.result;
    if (!cg.result.pass) mergeProblem = "post-merge-gate-failed";
    else {
      // 前移集成分支：先 fetch 确认远端没有被别人动过，再带 lease 推送
      const fresh = push(["--force-with-lease=" + `refs/heads/${specBranch}:${specHead}`, REMOTE, `${mc.candidate}:refs/heads/${specBranch}`]);
      if (fresh.code !== 0) blocked("push-failed", `前移 ${specBranch} 被拒绝：${fresh.out.slice(0, 300)}`);
      git(["update-ref", `refs/heads/${specBranch}`, mc.candidate!, specHead]);
      rememberGate(mc.candidate!, cg.result);
      timeline.push({ stage: `前移 ${specBranch} ${specHead.slice(0, 7)} → ${mc.candidate!.slice(0, 7)}（--force-with-lease）`, ms: 0, ok: true });
      specHead = mc.candidate!;
      currentBaseline = cg.result;
      finish({ state: "done" });
    }
  }

  // merge-fix（最多一次）
  if (fixes.merge >= 1) blocked(mergeProblem!, mc.conflict ? mc.detail : candidateGate?.reasons.join("; "));
  fixes.merge++;
  step = await agentStage("merge-fix", { failure: mc.conflict ? `# merge-tree 冲突\n\n${mc.detail}\n` : candidateGate!.failureLog });
  checkAgentOutcome(step);
  await stampAndPush(lastStamped, "merge-fix");
  lastStamped = gitOut(["rev-parse", agentBranch]);
}
blocked("loop-guard", "流水线循环次数超过保护上限");
