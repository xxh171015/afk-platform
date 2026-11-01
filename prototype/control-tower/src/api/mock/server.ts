// 内存 mock 后端：实现与真实端点相同的读写语义，并模拟「活的」系统（running 的票会推进）。
import {
  ApiError,
  type BlockedResponse,
  type Edge,
  type ListSpecsResponse,
  type MergeOrder,
  type OkResponse,
  type OrderBroken,
  type Progress,
  type RecentRunsResponse,
  type RetryMode,
  type Run,
  type RunDetailResponse,
  type RunLogsResponse,
  type SearchMatch,
  type SearchResponse,
  type Spec,
  type SpecDetailResponse,
  type SpecSummary,
  type Ticket,
  type TicketDetailResponse,
  type TicketRef,
} from "../types";
import { createSeed, fakeSha, type MockDb } from "./seed";
import { keepClosedTimelineEvents } from "@/lib/view-map";

let db: MockDb | null = null;
let lastTick = 0;

function getDb(): MockDb {
  if (!db) db = createSeed();
  return db;
}

/** 测试用：重置 mock 状态，可关闭随机推进 */
export function resetMockDb(opts: { liveTicks?: boolean } = {}) {
  db = createSeed();
  liveTicks = opts.liveTicks ?? true;
  lastTick = 0;
}

let liveTicks = true;

const nowIso = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

/* ---------------- 派生数据 ---------------- */

export function computeProgress(tickets: Ticket[]): Progress {
  const p: Progress = { total: tickets.length, done: 0, active: 0, blocked: 0, pending: 0, cancelled: 0 };
  for (const t of tickets) {
    if (t.state === "done") p.done++;
    else if (t.state === "blocked") p.blocked++;
    else if (t.state === "cancelled") p.cancelled++;
    else if (t.state === "pending") p.pending++;
    else p.active++;
  }
  return p;
}

function summary(s: Spec, d: MockDb): SpecSummary {
  const tickets = d.tickets.filter((t) => t.specId === s.id);
  return {
    id: s.id,
    displayId: s.displayId,
    slug: s.slug,
    title: s.title,
    type: s.type,
    state: s.state,
    pauseReason: s.pauseReason,
    project: s.project,
    progress: computeProgress(tickets),
  };
}

/** 由 contract 边推出合并顺序：提供契约的仓库先合 */
export function computeMergeOrder(repos: string[], tickets: Ticket[], edges: Edge[]): MergeOrder {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const after: Record<string, string[]> = {};
  for (const e of edges) {
    if (e.kind !== "contract") continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || from.repo === to.repo) continue;
    const list = (after[to.repo] ??= []);
    if (!list.includes(from.repo)) list.push(from.repo);
  }
  const involved = new Set<string>([...Object.keys(after), ...Object.values(after).flat()]);
  const ordered: string[] = [];
  const visit = (r: string, seen = new Set<string>()) => {
    if (ordered.includes(r) || seen.has(r)) return;
    seen.add(r);
    for (const dep of after[r] ?? []) visit(dep, seen);
    ordered.push(r);
  };
  [...involved].sort().forEach((r) => visit(r));
  return { ordered, after, unordered: repos.filter((r) => !involved.has(r)) };
}

function orderBroken(specId: string, order: MergeOrder, d: MockDb): OrderBroken[] {
  const prs = d.pullRequests.filter((p) => p.specId === specId);
  const out: OrderBroken[] = [];
  for (const pr of prs) {
    if (pr.state !== "merged") continue;
    const skipped = (order.after[pr.repo] ?? []).filter(
      (dep) => !prs.some((p) => p.repo === dep && p.state === "merged"),
    );
    if (skipped.length) out.push({ repo: pr.repo, skipped });
  }
  return out;
}

function ref(t: Ticket, kind: Edge["kind"]): TicketRef {
  return { id: t.id, displayId: t.displayId, title: t.title, state: t.state, repo: t.repo, kind };
}

/* ---------------- 模拟推进 ---------------- */

function newRun(d: MockDb, t: Ticket, stage: Run["stage"], summaryText: string): Run {
  const n = ++d.counters.run;
  const r: Run = {
    id: `run_${n}`,
    displayId: `R-${n}`,
    specId: t.specId,
    ticketId: t.id,
    stage,
    attempt: t.attempts,
    state: "running",
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    summary: summaryText,
    model: ["implement", "review", "gate-fix", "review-fix", "merge-fix", "diagnose"].includes(stage) ? "claude-sonnet-4.6" : null,
    skillsSha: fakeSha(d.counters.sha++),
    contractRefs: [{ repo: "afk-pilot-backend", sha: t.contractSha ?? fakeSha(d.counters.sha++) }],
    refsSha: fakeSha(d.counters.sha++),
  };
  d.runs.push(r);
  return r;
}

function finishRuns(d: MockDb, t: Ticket, state: Run["state"]) {
  for (const r of d.runs) {
    if (r.ticketId === t.id && r.state === "running") {
      r.state = state;
      r.finishedAt = nowIso();
      r.exitCode = state === "succeeded" ? 0 : 1;
      if (state === "succeeded") r.summary = r.summary.replace("正在", "已");
    }
  }
}

function upstreamDone(d: MockDb, t: Ticket) {
  return d.edges
    .filter((e) => e.to === t.id)
    .every((e) => d.tickets.find((x) => x.id === e.from)?.state === "done");
}

/** 每次请求最多每 2 秒推进一次 */
export function tick(force = false) {
  const d = getDb();
  const now = Date.now();
  if (!force && (!liveTicks || now - lastTick < 2000)) return;
  lastTick = now;
  const rnd = () => Math.random();

  for (const s of d.specs) {
    if (s.state !== "running" && s.state !== "reworking") continue;
    for (const t of d.tickets.filter((x) => x.specId === s.id)) {
      if (t.state === "merging" && rnd() < 0.35) {
        finishRuns(d, t, "succeeded");
        t.state = "done";
        t.headSha = fakeSha(d.counters.sha++);
        t.updatedAt = nowIso();
      } else if (t.state === "running" && rnd() < 0.2) {
        finishRuns(d, t, "succeeded");
        t.state = "merging";
        newRun(d, t, "merge", `正在合并到 ${s.integrationBranch}`);
        t.updatedAt = nowIso();
      } else if (t.state === "queued" && rnd() < 0.3) {
        t.state = "running";
        t.attempts = Math.max(1, t.attempts);
        newRun(d, t, "implement", "正在实现…");
        t.updatedAt = nowIso();
      } else if (t.state === "pending" && upstreamDone(d, t) && rnd() < 0.4) {
        t.state = "queued";
        t.updatedAt = nowIso();
      }
    }
    const tickets = d.tickets.filter((x) => x.specId === s.id);
    if (tickets.length && tickets.every((t) => t.state === "done" || t.state === "cancelled")) {
      s.state = "finalizing";
      s.updatedAt = nowIso();
      for (const step of ["final-e2e", "final-review", "final-fix", "final-merge"] as const) {
        if (!d.finalizations.some((f) => f.specId === s.id && f.step === step)) {
          d.finalizations.push({
            id: `fin_${s.id}_${step}`,
            specId: s.id,
            specDisplayId: s.displayId,
            step,
            repo: null,
            runDisplayId: null,
            state: step === "final-e2e" ? "running" : "pending",
            blockedReason: null,
            blockedDetail: null,
            runId: null,
            updatedAt: nowIso(),
          });
        }
      }
    }
  }
}

/* ---------------- 读接口 ---------------- */

function findSpec(d: MockDb, id: string): Spec {
  const s = d.specs.find((x) => x.id === id || x.displayId === id);
  if (!s) throw new ApiError(404, `spec ${id} not found`);
  return s;
}

function findTicket(d: MockDb, id: string): Ticket {
  const t = d.tickets.find((x) => x.id === id || x.displayId === id);
  if (!t) throw new ApiError(404, `ticket ${id} not found`);
  return t;
}

export function listSpecs(): ListSpecsResponse {
  tick();
  const d = getDb();
  return clone({ specs: d.specs.map((s) => summary(s, d)) });
}

export function getSpec(id: string): SpecDetailResponse {
  tick();
  const d = getDb();
  const s = findSpec(d, id);
  const tickets = d.tickets.filter((t) => t.specId === s.id);
  const ids = new Set(tickets.map((t) => t.id));
  const edges = d.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const mergeOrder = computeMergeOrder(
    s.repos.map((r) => r.name),
    tickets,
    edges,
  );
  return clone({
    timeline: keepClosedTimelineEvents(d.timelines[s.id] ?? []),
    spec: { ...s, progress: computeProgress(tickets) },
    tickets,
    edges,
    finalizations: d.finalizations.filter((f) => f.specId === s.id),
    pullRequests: d.pullRequests.filter((p) => p.specId === s.id).map(p => ({ ...p, waitsFor: p.state === "merged" ? [] : (mergeOrder.after[p.repo] ?? []).filter(repo => !d.pullRequests.some(upstream => upstream.specId === s.id && upstream.repo === repo && upstream.state === "merged")) })),
    mergeOrder,
    orderBroken: orderBroken(s.id, mergeOrder, d),
    acceptancePack: d.acceptancePacks[s.id] ?? null,
    importWarnings: s.id === "spec_17" ? [{ id: "warn_17_glob", message: "T-152 未声明模块 glob，无法核对并行改动范围，请在确认前检查。", ticketIds: ["tkt_152"], paths: [] }] : [],
    runs: d.runs.filter((r) => r.specId === s.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    agentUsedSeconds: Math.round(d.runs.filter((r) => r.specId === s.id && ["implement", "review", "gate-fix", "review-fix", "merge-fix", "diagnose", "final-review", "final-fix"].includes(r.stage)).reduce((total, r) => total + Math.max(0, Date.parse(r.finishedAt ?? nowIso()) - Date.parse(r.startedAt)), 0) / 1000),
  });
}

export function getTicket(id: string): TicketDetailResponse {
  tick();
  const d = getDb();
  const t = findTicket(d, id);
  const upstream = d.edges
    .filter((e) => e.to === t.id)
    .map((e) => ref(findTicket(d, e.from), e.kind));
  const downstream = d.edges
    .filter((e) => e.from === t.id)
    .map((e) => ref(findTicket(d, e.to), e.kind));
  const fixes = d.tickets.filter((x) => x.specId === t.specId && x.type === "fix");
  return clone({
    ticket: t,
    versions: d.versions[t.id] ?? [],
    runs: d.runs.filter((r) => r.ticketId === t.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    findings: d.findings.filter((f) => f.ticketId === t.id),
    gateResults: d.gateResults.filter((g) => g.ticketId === t.id),
    upstream,
    downstream,
    integration:
      t.type === "integration"
        ? { loops: 1, maxLoops: 2, lastSide: "backend", lastDiagnosis: "后端 maxLength 校验允许 201 字，已开修复票。", fixTicketIds: fixes.map((f) => f.id), attempts: d.runs.filter(r => r.ticketId === t.id && r.stage === "e2e").map(r => ({ runId: r.id, failedTests: r.state === "failed" ? 1 : 0, totalTests: 12, builds: [...new Set(d.tickets.filter(x => x.specId === t.specId).map(x => x.repo))].map(repo => ({ repo, sha: d.tickets.find(x => x.specId === t.specId && x.repo === repo && x.headSha)?.headSha ?? fakeSha(41) })), diagnosis: { repo: "afk-pilot-backend", evidence: "POST /orders note.length=201 → 200 OK\nexpected 422 VALIDATION_ERROR\nmaxLength validation: length > 201", failedCases: ["order-note.spec.ts › rejects note longer than 200"] } })) }
        : null,
    brief: (() => { const r = d.runs.filter(r => r.ticketId === t.id).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0]; return r ? { runId: r.id, stage: r.stage, state: r.state, output: { summary: r.summary, outcome: r.state, artifacts: { branch: t.branch, commit: t.headSha }, checks: { gate: t.blockedReason === "gate-failed" ? "failed" : "pending", protectedPaths: t.protectedPaths }, nextAction: t.blockedReason ? "human-required" : "continue" } } : null; })(),
    fixTickets: t.type === "integration" ? fixes : [],
  });
}

export function getRun(id: string): RunDetailResponse {
  tick();
  const d = getDb();
  const r = d.runs.find(x => x.id === id || x.displayId === id);
  if (!r) throw new ApiError(404, `run ${id} not found`);
  const s = findSpec(d, r.specId);
  const t = r.ticketId ? findTicket(d, r.ticketId) : null;
  const failedImplement = r.stage === "implement" && r.state === "failed";
  const count = r.stage === "implement" && r.state === "succeeded" ? 3 : failedImplement ? 1 : 0;
  return clone({
    run: r,
    ticket: t ? { id: t.id, displayId: t.displayId, title: t.title } : null,
    spec: { id: s.id, displayId: s.displayId, title: s.title },
    prompt: `执行阶段 ${r.stage}，第 ${r.attempt} 次尝试。\n${t ? `票 ${t.displayId}：${t.title}` : `需求 ${s.displayId}：${s.title}`}\n${t?.body ?? s.body}\n遵守仓库规范，提供验收测试证据，不合并 PR。`,
    output: { summary: r.summary, outcome: r.state, nextAction: r.state === "failed" ? "检查失败用例并修正实现" : r.state === "running" ? "继续执行当前阶段" : "进入后续调度阶段", ...(failedImplement ? { failingTests: ["shows 200/200 at limit", "blocks submit above limit"] } : {}) },
    commits: Array.from({ length: count }, (_, i) => ({ sha: fakeSha(Number(r.displayId.slice(2)) * 10 + i), message: failedImplement ? "WIP: 备注字数计数修复，边界测试仍失败" : ["实现订单备注行为", "补充边界测试", "整理实现与测试证据"][i] ?? "实现提交" })),
  });
}

function buildLog(r: Run): string {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: r.model ?? "deterministic", run: r.displayId, attempt: r.attempt, environment: { API_KEY: "***", sandbox: `sbx-${r.id}` } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `开始 ${r.stage}：先读取票与仓库规范，确认验收标准。` }] } }),
    JSON.stringify({ type: "tool_call", name: "read_file", arguments: { path: "src/checkout/CheckoutNote.tsx" }, summary: "读取结算页备注组件" }),
    JSON.stringify({ type: "tool_call", name: "strreplace", arguments: { path: "src/checkout/CheckoutNote.tsx" }, summary: "替换 CheckoutNote 字数计数" }),
    JSON.stringify({ type: "tool_call", name: "write", arguments: { path: "src/checkout/CheckoutNote.test.tsx" }, summary: "写入边界测试" }),
    JSON.stringify({ type: "tool_call", name: "bash", summary: "pnpm test" }),
  ];
  for (let i = 0; i < 36; i++) {
    lines.push(JSON.stringify({ type: i % 3 === 0 ? "tool_result" : "assistant", sequence: i + 1, summary: ["检查 maxLength 与字数计数", "补充 200 字边界测试", "执行 test 并检查输出"][i % 3], message: { content: [{ type: "text", text: `步骤 ${i + 1}：确认订单备注行为，保留既有代码与测试约束。` }] } }));
  }
  lines.push("$ pnpm typecheck", "\u001b[32m✓ typecheck passed\u001b[0m", "$ pnpm test", r.state === "failed" ? "\u001b[31mFAIL src/checkout/CheckoutNote.test.tsx\u001b[0m\n  ✕ shows 200/200 at limit\nexpected 200/200 but received 201/200\nTests: 2 failed | 38 passed" : "\u001b[32mTests: 40 passed\u001b[0m");
  lines.push(JSON.stringify({ type: "result", subtype: r.state, summary: r.summary, api_key: "***", exitCode: r.exitCode }));
  if (r.finishedAt) lines.push(`[afk] exit ${r.exitCode ?? 0}`);
  return lines.join("\n") + "\n";
}

export function getRunLogs(id: string, offset = 0): RunLogsResponse {
  tick();
  const d = getDb();
  const r = d.runs.find((x) => x.id === id || x.displayId === id);
  if (!r) throw new ApiError(404, `run ${id} not found`);
  const full = buildLog(r);
  // 运行中的日志随时间增长
  const visible = r.finishedAt
    ? full.length
    : Math.min(full.length, 400 + Math.floor((Date.now() - Date.parse(r.startedAt)) / 50));
  const CHUNK = 4096;
  const start = Math.max(0, Math.min(offset, visible));
  const end = Math.min(visible, start + CHUNK);
  return {
    attempt: r.attempt,
    offset: start,
    nextOffset: end,
    size: visible,
    text: full.slice(start, end),
    finished: r.finishedAt !== null && end >= full.length,
  };
}

export function getBlocked(): BlockedResponse {
  tick();
  const d = getDb();
  return clone({
    tickets: d.tickets.filter((t) => t.state === "blocked"),
    finalizations: d.finalizations.filter((f) => f.state === "blocked"),
    pullRequests: d.pullRequests.filter((p) => p.state === "closed" || p.syncError !== null),
    cleanups: d.cleanups,
    readyFailures: d.readyFailures,
    specs: d.specs.filter((s) => s.state === "paused").map((s) => summary(s, d)),
  });
}

export function blockedCount(b: BlockedResponse): number {
  return b.tickets.length + b.finalizations.length + b.pullRequests.length + b.cleanups.length + b.readyFailures.length + b.specs.length;
}

export function search(q: string): SearchResponse {
  if (q.length > 200) throw new ApiError(400, "搜索最多 200 个字符");
  const d = getDb();
  const needle = q.trim().toLowerCase();
  if (!needle) return { specs: [], tickets: [] };
  const match = (id: string, title: string, body: string): SearchMatch[] => {
    const m: SearchMatch[] = [];
    if (id.toLowerCase().includes(needle)) m.push("id");
    if (title.toLowerCase().includes(needle)) m.push("title");
    if (body.toLowerCase().includes(needle)) m.push("body");
    return m;
  };
  const exactSpec = d.specs.find(s => s.displayId.toLowerCase() === needle);
  const exactTicket = d.tickets.find(t => t.displayId.toLowerCase() === needle);
  const exactRun = d.runs.find(r => r.displayId.toLowerCase() === needle);
  const jump: SearchResponse["jump"] = exactSpec
    ? { kind: "spec", id: exactSpec.id, displayId: exactSpec.displayId, title: exactSpec.title, state: exactSpec.state }
    : exactTicket
      ? { kind: "ticket", id: exactTicket.id, displayId: exactTicket.displayId, title: exactTicket.title, state: exactTicket.state, specDisplayId: exactTicket.specDisplayId }
      : exactRun
        ? { kind: "run", id: exactRun.id, displayId: exactRun.displayId, title: exactRun.summary, stage: exactRun.stage, state: exactRun.state, ticketId: exactRun.ticketId, specId: exactRun.specId, specDisplayId: findSpec(d, exactRun.specId).displayId }
        : undefined;
  return clone({
    ...(jump ? { jump } : {}),
    specs: d.specs
      .map((s) => ({ ...summary(s, d), bodySnippet: s.body, matched: match(`${s.displayId} ${s.slug}`, s.title, s.body) }))
      .filter((s) => s.matched.length),
    tickets: d.tickets
      .map((t) => ({ ...t, matched: match(t.displayId, t.title, t.body) }))
      .filter((t) => t.matched.length)
      .slice(0, 20),
  });
}

export function recentRuns(limit = 15): RecentRunsResponse {
  tick();
  const d = getDb();
  const runs = d.runs
    .filter((r) => r.finishedAt)
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, limit)
    .map((r) => {
      const t = r.ticketId ? d.tickets.find((x) => x.id === r.ticketId) : undefined;
      const s = d.specs.find((x) => x.id === r.specId);
      return {
        ...r,
        ticketDisplayId: t?.displayId ?? null,
        ticketTitle: t?.title ?? null,
        specDisplayId: s?.displayId ?? "",
        durationMs: r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null,
      };
    });
  return clone({ runs });
}

/* ---------------- 写接口 ---------------- */

const OK: OkResponse = { ok: true };

export function confirmSpec(id: string): OkResponse {
  const d = getDb();
  const s = findSpec(d, id);
  if (s.state !== "draft") throw new ApiError(409, `spec ${s.displayId} is ${s.state}, not draft`);
  if (!d.tickets.some((t) => t.specId === s.id)) throw new ApiError(409, "先导入票（plat tickets import）");
  s.state = "running";
  s.confirmedAt = nowIso();
  s.updatedAt = nowIso();
  for (const t of d.tickets.filter((x) => x.specId === s.id)) {
    if (upstreamDone(d, t)) t.state = "queued";
  }
  return OK;
}

export const MAX_EXTRA_SECONDS = 604800;

export function resumeSpec(id: string, extraSeconds: number): OkResponse {
  const d = getDb();
  const s = findSpec(d, id);
  if (!Number.isInteger(extraSeconds) || extraSeconds < 1 || extraSeconds > MAX_EXTRA_SECONDS) {
    throw new ApiError(400, `extraSeconds must be an integer in 1…${MAX_EXTRA_SECONDS}`);
  }
  if (s.state !== "paused") throw new ApiError(409, `spec ${s.displayId} is not paused`);
  s.state = "running";
  s.pauseReason = null;
  s.deadlineAt = new Date(Date.now() + extraSeconds * 1000).toISOString();
  s.updatedAt = nowIso();
  return OK;
}

function blockedFinalization(d: MockDb, specId: string) {
  const s = findSpec(d, specId);
  const f = d.finalizations.find((x) => x.specId === s.id && x.state === "blocked");
  if (!f) throw new ApiError(409, `spec ${s.displayId} has no blocked finalization step`);
  return { s, f };
}

export function retryFinal(id: string): OkResponse {
  const d = getDb();
  const { f } = blockedFinalization(d, id);
  f.state = "running";
  f.blockedReason = null;
  f.blockedDetail = null;
  f.updatedAt = nowIso();
  return OK;
}

export function waiveFinal(id: string): OkResponse {
  const d = getDb();
  const { s, f } = blockedFinalization(d, id);
  f.state = "waived";
  f.updatedAt = nowIso();
  const next = d.finalizations.find((x) => x.specId === s.id && x.state === "pending");
  if (next) next.state = "running";
  return OK;
}

export function retryTicket(id: string, mode: RetryMode): OkResponse {
  const d = getDb();
  const t = findTicket(d, id);
  if (mode !== "continue" && mode !== "restart") throw new ApiError(400, "mode must be continue or restart");
  if (t.state !== "blocked") throw new ApiError(409, `ticket ${t.displayId} is not blocked`);
  t.state = "queued";
  t.blockedReason = null;
  t.blockedDetail = null;
  t.attempts += 1;
  t.blockedRun = null;
  if (mode === "restart") t.headSha = null;
  t.updatedAt = nowIso();
  return OK;
}

export function approveProtected(id: string): OkResponse {
  const d = getDb();
  const t = findTicket(d, id);
  if (t.state !== "blocked" || t.blockedReason !== "protected-path-changed") {
    throw new ApiError(409, `ticket ${t.displayId} is not blocked on protected-path-changed`);
  }
  t.state = "merging";
  t.approvedProtectedPaths = [...new Set([...t.approvedProtectedPaths, ...t.protectedPaths])];
  t.protectedPaths = [];
  t.blockedRun = null;
  t.blockedReason = null;
  t.blockedDetail = null;
  t.updatedAt = nowIso();
  newRun(d, t, "merge", "人工批准受保护路径改动，正在合并");
  return OK;
}

export function cancelTicket(id: string, cascade: boolean): OkResponse {
  const d = getDb();
  const t = findTicket(d, id);
  if (t.state === "done" || t.state === "cancelled") throw new ApiError(409, `ticket ${t.displayId} is ${t.state}`);
  const cancel = (x: Ticket) => {
    finishRuns(d, x, "cancelled");
    x.state = "cancelled";
    x.updatedAt = nowIso();
  };
  cancel(t);
  const walk = (from: Ticket) => {
    for (const e of d.edges.filter((e) => e.from === from.id)) {
      const down = findTicket(d, e.to);
      if (down.state === "done" || down.state === "cancelled") continue;
      if (cascade) {
        cancel(down);
        walk(down);
      } else {
        down.state = "blocked";
        down.blockedReason = "upstream-cancelled";
        down.blockedDetail = `上游 ${from.displayId}「${from.title}」已取消`;
        down.blockedRun = null;
        down.updatedAt = nowIso();
      }
    }
  };
  walk(t);
  return OK;
}
