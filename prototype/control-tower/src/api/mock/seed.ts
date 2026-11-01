// 内存 mock 的初始数据。只在 createSeed() 被调用时构造（不要在模块顶层生成随机数据）。
import type {
  AcceptancePack,
  BlockedReason,
  Cleanup,
  Edge,
  Finalization,
  Finding,
  GateResult,
  PullRequest,
  ReadyFailure,
  Repo,
  Run,
  Spec,
  SpecState,
  SpecType,
  SpecTimelineEvent,
  Ticket,
  TicketState,
  TicketType,
  TicketVersion,
} from "../types";

export const BACKEND = "afk-pilot-backend";
export const FRONTEND = "afk-pilot-frontend";

export const REPOS: Repo[] = [
  { name: BACKEND, contractPath: "openapi/openapi.yaml", defaultBranch: "main" },
  { name: FRONTEND, contractPath: null, defaultBranch: "main" },
];

export interface MockDb {
  timelines: Record<string, SpecTimelineEvent[]>;
  specs: Spec[];
  tickets: Ticket[];
  edges: Edge[];
  versions: Record<string, TicketVersion[]>;
  runs: Run[];
  gateResults: GateResult[];
  findings: Finding[];
  finalizations: Finalization[];
  pullRequests: PullRequest[];
  acceptancePacks: Record<string, AcceptancePack>;
  cleanups: Cleanup[];
  readyFailures: ReadyFailure[];
  counters: { run: number; sha: number };
}

const HOUR = 3600_000;

export function fakeSha(seed: number): string {
  let h = (seed * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < 40; i++) {
    h = (h * 1103515245 + 12345 + i) >>> 0;
    out += (h % 16).toString(16);
  }
  return out;
}

export function createSeed(now = Date.now()): MockDb {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const db: MockDb = {
    timelines: {},
    specs: [],
    tickets: [],
    edges: [],
    versions: {},
    runs: [],
    gateResults: [],
    findings: [],
    finalizations: [],
    pullRequests: [],
    acceptancePacks: {},
    cleanups: [],
    readyFailures: [],
    counters: { run: 455, sha: 1 },
  };

  const nextSha = () => fakeSha(db.counters.sha++);

  function spec(
    n: number,
    slug: string,
    title: string,
    type: SpecType,
    state: SpecState,
    body: string,
    extra: Partial<Spec> = {},
  ): Spec {
    const s: Spec = {
      id: `spec_${n}`,
      displayId: `S-${n}`,
      slug,
      title,
      type,
      state,
      pauseReason: null,
      anomalyFrom: null,
      etaMinutes: n === 12 ? 40 : n === 13 ? 15 : null,
      project: "shop",
      progress: { total: 0, done: 0, active: 0, blocked: 0, pending: 0, cancelled: 0 },
      body,
      repos: REPOS,
      integrationBranch: `afk/S-${n}-${slug}`,
      createdAt: iso(72 * HOUR - n * HOUR),
      confirmedAt: state === "draft" ? null : iso(48 * HOUR - n * HOUR),
      deadlineAt: state === "draft" ? null : new Date(now + 6 * HOUR).toISOString(),
      updatedAt: iso(10 * 60_000),
      ...extra,
    };
    db.specs.push(s);
    return s;
  }

  function ticket(
    s: Spec,
    n: number,
    repo: string,
    type: TicketType,
    state: TicketState,
    title: string,
    body: string,
    extra: Partial<Ticket> = {},
  ): Ticket {
    const t: Ticket = {
      id: `tkt_${n}`,
      displayId: `T-${n}`,
      specId: s.id,
      specDisplayId: s.displayId,
      repo,
      type,
      state,
      title,
      body,
      blockedReason: null,
      blockedDetail: null,
      contentVersion: 1,
      appended: false,
      branch: `afk/${s.displayId}/T-${n}`,
      headSha: state === "done" || state === "merging" ? nextSha() : null,
      contractSha: null,
      attempts: state === "pending" || state === "queued" ? 0 : 1,
      blockedRun: null,
      protectedPaths: [],
      approvedProtectedPaths: [],
      acceptanceCriteria: [{ id: `criterion_${n}`, text: `完成「${title}」并提供对应自动化测试`, status: "unverified", reason: "尚未关联测试证据", evidence: null }],
      updatedAt: iso(n * 7 * 60_000 % (5 * HOUR)),
      ...extra,
    };
    db.tickets.push(t);
    const versions: TicketVersion[] = [];
    for (let v = 1; v <= t.contentVersion; v++) {
      versions.push({
        version: v,
        title: t.title,
        body: v === t.contentVersion ? t.body : `${t.body}\n\n（v${v} 旧版本描述）`,
        createdAt: iso((t.contentVersion - v + 1) * 5 * HOUR),
        author: v === 1 ? "plan" : "plat ticket edit",
        acceptanceCriteria: t.acceptanceCriteria.map(c => ({ ...c, text: v === t.contentVersion ? c.text : `v${v}：${c.text}` })),
      });
    }
    db.versions[t.id] = versions;
    return t;
  }

  function run(
    t: Ticket | null,
    s: Spec,
    stage: Run["stage"],
    state: Run["state"],
    msAgo: number,
    summary: string,
    durationMs = 4 * 60_000,
    attempt = 1,
  ): Run {
    const n = ++db.counters.run;
    const r: Run = {
      id: `run_${n}`,
      displayId: `R-${n}`,
      specId: s.id,
      ticketId: t?.id ?? null,
      stage,
      attempt,
      state,
      startedAt: iso(msAgo),
      finishedAt: state === "running" ? null : iso(Math.max(0, msAgo - durationMs)),
      exitCode: state === "running" ? null : state === "succeeded" ? 0 : 1,
      summary,
      model: ["implement", "review", "gate-fix", "review-fix", "merge-fix", "diagnose"].includes(stage) ? "claude-sonnet-4.6" : null,
      skillsSha: nextSha(),
      contractRefs: t ? [{ repo: BACKEND, sha: t.contractSha ?? nextSha() }] : [],
      refsSha: nextSha(),
    };
    db.runs.push(r);
    return r;
  }

  function gate(r: Run, t: Ticket, passed: boolean, tests: number, skipped: number, failStep?: string) {
    const steps = (["setup", "typecheck", "lint", "test"] as const).map((name, i) => ({
      name,
      exitCode: failStep === name ? 1 : 0,
      durationMs: [18_000, 9_500, 4_200, 61_000][i] ?? 0,
    }));
    db.gateResults.push({
      id: `gate_${r.id}`,
      runId: r.id,
      ticketId: t.id,
      passed,
      tests,
      skipped,
      durationMs: steps.reduce((a, b) => a + b.durationMs, 0),
      steps,
      createdAt: r.finishedAt ?? r.startedAt,
      commitSha: t.headSha ?? nextSha(),
      hasJunit: true,
    });
  }

  function doneTicketRuns(t: Ticket, s: Spec, msAgo: number) {
    run(t, s, "implement", "succeeded", msAgo, "实现完成，提交 3 个 commit");
    const g = run(t, s, "gate", "succeeded", msAgo - 5 * 60_000, "门禁通过", 90_000);
    gate(g, t, true, 40 + (Number(t.id.slice(4)) % 30), 1);
    run(t, s, "review", "succeeded", msAgo - 7 * 60_000, "自审通过，无阻塞意见", 60_000);
    run(t, s, "merge", "succeeded", msAgo - 9 * 60_000, `已合并到 ${s.integrationBranch}`, 20_000);
  }

  function block(t: Ticket, reason: BlockedReason, detail: string) {
    t.state = "blocked";
    t.blockedReason = reason;
    t.blockedDetail = detail;
  }

  /* ---------------- S-12 订单备注（running，8 张票） ---------------- */
  const s12 = spec(
    12,
    "order-note",
    "订单备注",
    "feature",
    "running",
    "买家下单时可填写最多 200 字的订单备注；商家在订单详情和后台列表中可以看到备注。备注需经过敏感词过滤。",
  );
  const t101 = ticket(s12, 101, BACKEND, "contract", "done", "定义订单备注 OpenAPI 契约", "在 openapi/openapi.yaml 中为 Order 增加 note 字段（string, maxLength 200），新增 PATCH /orders/{id}/note。", { contractSha: nextSha() });
  const t102 = ticket(s12, 102, BACKEND, "implementation", "done", "订单备注存储与接口", "orders 表新增 note 列及迁移；实现 PATCH /orders/{id}/note，返回更新后的 Order。");
  const t103 = ticket(s12, 103, FRONTEND, "implementation", "blocked", "下单页备注输入框", "结算页增加备注输入框，字数计数，超过 200 字禁止提交。", { contentVersion: 2 });
  block(t103, "gate-failed", [
    "$ pnpm vitest run --reporter=dot",
    "",
    " FAIL  src/checkout/CheckoutNote.test.tsx > CheckoutNote > shows counter at limit",
    "AssertionError: expected '201/200' to be '200/200'",
    "  ❯ src/checkout/CheckoutNote.test.tsx:42:31",
    "     40|     await user.type(input, 'a'.repeat(200));",
    "     41|     const counter = screen.getByTestId('note-counter');",
    "     42|     expect(counter.textContent).toBe('200/200');",
    "       |                               ^",
    "",
    " FAIL  src/checkout/CheckoutNote.test.tsx > CheckoutNote > blocks submit above limit",
    "AssertionError: expected button not to be disabled",
    "  ❯ src/checkout/CheckoutNote.test.tsx:58:40",
    "",
    " Test Files  1 failed | 11 passed (12)",
    "      Tests  2 failed | 38 passed (40)",
    "   Duration  61.02s",
    "",
    "[afk] gate step `test` exit 1 (attempt 2/2, gate-fix already used)",
  ].join("\n"));
  const t104 = ticket(s12, 104, FRONTEND, "implementation", "running", "订单详情页展示备注", "订单详情页在收货信息下方展示备注，空备注不展示区块。");
  const t105 = ticket(s12, 105, BACKEND, "implementation", "blocked", "备注敏感词过滤", "保存备注前调用敏感词服务，命中时返回 422。");
  block(t105, "protected-path-changed", "M config/security/sensitive-words.yaml  (+42 −3)\nA migrations/2026_11_01_note_filter.sql  (+18)");
  t105.protectedPaths = ["config/security/sensitive-words.yaml", "migrations/**"];
  const t106 = ticket(s12, 106, FRONTEND, "integration", "pending", "订单备注前后端联调", "在 e2e 环境中走通：下单填写备注 → 详情页可见 → 后台列表可见。");
  const t107 = ticket(s12, 107, BACKEND, "fix", "running", "修复备注长度校验 off-by-one", "联调发现后端允许 201 字，maxLength 校验差一。");
  const t108 = ticket(s12, 108, FRONTEND, "implementation", "pending", "后台订单列表显示备注图标", "后台订单列表中有备注的订单显示图标，hover 显示备注全文。", { appended: true });
  db.edges.push(
    { from: t101.id, to: t102.id, kind: "blocks" },
    { from: t101.id, to: t103.id, kind: "contract" },
    { from: t101.id, to: t104.id, kind: "contract" },
    { from: t102.id, to: t105.id, kind: "blocks" },
    { from: t102.id, to: t106.id, kind: "blocks" },
    { from: t103.id, to: t106.id, kind: "blocks" },
    { from: t104.id, to: t106.id, kind: "blocks" },
    { from: t107.id, to: t106.id, kind: "blocks" },
    { from: t104.id, to: t108.id, kind: "blocks" },
  );
  doneTicketRuns(t101, s12, 6 * HOUR);
  doneTicketRuns(t102, s12, 5 * HOUR);
  run(t103, s12, "implement", "succeeded", 3 * HOUR, "实现完成，提交 2 个 commit");
  const g103 = run(t103, s12, "gate", "failed", 2.9 * HOUR, "test 失败：2 failed, 38 passed", 95_000);
  gate(g103, t103, false, 40, 2, "test");
  run(t103, s12, "gate-fix", "succeeded", 2.8 * HOUR, "修正字数计数逻辑", 3 * 60_000);
  const g103b = run(t103, s12, "gate", "failed", 2.7 * HOUR, "test 仍失败：2 failed, 38 passed", 95_000, 2);
  gate(g103b, t103, false, 40, 2, "test");
  t103.blockedRun = { id: g103b.id, displayId: g103b.displayId, stage: "gate", state: "failed" };
  run(t106, s12, "e2e", "failed", HOUR, "备注长度联调：1 failed / 12 tests", 180000);
  run(t106, s12, "diagnose", "succeeded", HOUR - 190000, "afk-pilot-backend 长度校验差一", 60000);
  db.findings.push(
    { id: "fd_1", specId: s12.id, ticketId: t103.id, runId: g103b.id, source: "gate", severity: "blocker", title: "CheckoutNote 字数计数越界", detail: "expected '200/200' but received '201/200'", file: "src/checkout/CheckoutNote.test.tsx", line: 42, resolution: "unhandled" },
    { id: "fd_2", specId: s12.id, ticketId: t103.id, runId: g103b.id, source: "review", severity: "minor", title: "备注输入框缺少 aria-label", detail: "建议补充无障碍标签。", file: "src/checkout/CheckoutNote.tsx", line: 18, resolution: "acceptance-pack" },
  );
  run(t104, s12, "implement", "running", 12 * 60_000, "正在实现…");
  run(t105, s12, "implement", "succeeded", 2 * HOUR, "实现完成");
  const g105 = run(t105, s12, "gate", "succeeded", 1.9 * HOUR, "门禁通过", 80_000);
  gate(g105, t105, true, 64, 0);
  const r105 = run(t105, s12, "review", "succeeded", 1.8 * HOUR, "自审：改动涉及受保护路径", 60_000);
  t105.blockedRun = { id: r105.id, displayId: r105.displayId, stage: "review", state: "succeeded" };

  /* ---------------- S-13 导出订单 CSV（finalizing） ---------------- */
  const s13 = spec(13, "export-orders-csv", "导出订单 CSV", "feature", "finalizing", "商家可按时间范围导出订单为 CSV，最多 5 万行，异步生成后下载。");
  const t110 = ticket(s13, 110, BACKEND, "contract", "done", "导出任务契约", "新增 POST /exports 与 GET /exports/{id}。", { contractSha: nextSha() });
  const t111 = ticket(s13, 111, BACKEND, "implementation", "done", "CSV 异步生成任务", "后台任务分页读取订单写入 CSV。");
  const t112 = ticket(s13, 112, FRONTEND, "implementation", "done", "导出按钮与进度提示", "订单列表页增加导出按钮，轮询任务状态。");
  db.edges.push(
    { from: t110.id, to: t111.id, kind: "blocks" },
    { from: t110.id, to: t112.id, kind: "contract" },
  );
  [t110, t111, t112].forEach((t, i) => doneTicketRuns(t, s13, (8 - i) * HOUR));
  const fe2e = run(null, s13, "final-e2e", "failed", 50 * 60_000, "联调环境三次未能启动", 6 * 60_000);
  db.finalizations.push(
    { repo: null, runDisplayId: null, id: "fin_13_e2e", specId: s13.id, specDisplayId: s13.displayId, step: "final-e2e", state: "blocked", blockedReason: "integration-environment-failed", blockedDetail: [
      "[e2e] docker compose up -d backend frontend",
      "[e2e] attempt 1/3: backend healthcheck GET /healthz → connection refused",
      "[e2e] attempt 2/3: backend healthcheck GET /healthz → connection refused",
      "[e2e] attempt 3/3: backend exited (137) — OOMKilled while building export worker",
      "[e2e] giving up: environment did not become healthy",
    ].join("\n"), runId: fe2e.id, updatedAt: iso(44 * 60_000) },
    { repo: BACKEND, runDisplayId: null, id: "fin_13_review", specId: s13.id, specDisplayId: s13.displayId, step: "final-review", state: "pending", blockedReason: null, blockedDetail: null, runId: null, updatedAt: iso(26 * 60_000) },
    { repo: null, runDisplayId: null, id: "fin_13_fix", specId: s13.id, specDisplayId: s13.displayId, step: "final-fix", state: "pending", blockedReason: null, blockedDetail: null, runId: null, updatedAt: iso(26 * 60_000) },
    { repo: null, runDisplayId: null, id: "fin_13_merge", specId: s13.id, specDisplayId: s13.displayId, step: "final-merge", state: "pending", blockedReason: null, blockedDetail: null, runId: null, updatedAt: iso(26 * 60_000) },
  );
  db.cleanups.push({ id: "cl_1", specId: s13.id, specDisplayId: s13.displayId, repo: FRONTEND, kind: "sandbox", target: "sbx-T-112-a3f9", error: "sandbox teardown timed out after 120s", createdAt: iso(3 * HOUR) });

  /* ---------------- S-14 优惠券叠加规则（awaiting-review） ---------------- */
  const s14 = spec(14, "coupon-stacking", "优惠券叠加规则", "improvement", "awaiting-review", "同一订单最多叠加 1 张平台券 + 1 张店铺券；满减券与折扣券互斥。");
  const t120 = ticket(s14, 120, BACKEND, "contract", "done", "优惠券叠加校验契约", "CouponValidation 返回 conflicts 字段。", { contractSha: nextSha() });
  const t121 = ticket(s14, 121, BACKEND, "implementation", "done", "叠加规则引擎", "实现叠加/互斥规则。", { contentVersion: 3 });
  const t122 = ticket(s14, 122, FRONTEND, "implementation", "done", "结算页券冲突提示", "选择冲突券时提示原因。");
  const t123 = ticket(s14, 123, FRONTEND, "integration", "done", "优惠券叠加联调", "e2e 验证叠加场景。", { appended: true });
  ticket(s14, 124, FRONTEND, "implementation", "cancelled", "旧版优惠券组合提示", "旧版提示方案已取消，改用 T-122 的冲突提示。");
  t121.approvedProtectedPaths = ["src/coupons/rules.go", "tests/coupons/legacy_cases.json"];
  db.edges.push(
    { from: t120.id, to: t121.id, kind: "blocks" },
    { from: t120.id, to: t122.id, kind: "contract" },
    { from: t121.id, to: t123.id, kind: "blocks" },
    { from: t122.id, to: t123.id, kind: "blocks" },
  );
  [t120, t121, t122, t123].forEach((t, i) => doneTicketRuns(t, s14, (20 - i) * HOUR));
  for (const step of ["final-e2e", "final-review", "final-fix", "final-merge"] as const) {
    const r = run(null, s14, step, "succeeded", 12 * HOUR, `${step} 完成`, 5 * 60_000);
    db.finalizations.push({ repo: null, runDisplayId: null, id: `fin_14_${step}`, specId: s14.id, specDisplayId: s14.displayId, step, state: "done", blockedReason: null, blockedDetail: null, runId: r.id, updatedAt: iso(11 * HOUR) });
  }
  db.pullRequests.push(
    { syncError: "GitHub API 502 Bad Gateway: GET /repos/shop/afk-pilot-backend/pulls/482", id: "pr_14_be", specId: s14.id, specDisplayId: s14.displayId, repo: BACKEND, number: 482, url: "https://github.com/shop/afk-pilot-backend/pull/482", title: "S-14 优惠券叠加规则", state: "open", draft: false, ci: "success", review: "approved", headSha: nextSha(), baseBranch: "main", headBranch: s14.integrationBranch, mergedAt: null },
    { syncError: null, id: "pr_14_fe", specId: s14.id, specDisplayId: s14.displayId, repo: FRONTEND, number: 311, url: "https://github.com/shop/afk-pilot-frontend/pull/311", title: "S-14 优惠券叠加规则", state: "open", draft: true, ci: "success", review: "none", headSha: nextSha(), baseBranch: "main", headBranch: s14.integrationBranch, mergedAt: null },
  );
  const f14: Finding = { id: "fd_14", specId: s14.id, ticketId: t122.id, runId: db.runs.at(-1)?.id ?? "", source: "review", severity: "major", title: "冲突提示文案未覆盖「折扣券+满减券」场景", detail: "建议人工确认文案。", file: "src/checkout/CouponConflict.tsx", line: 27, resolution: "acceptance-pack" };
  db.findings.push(f14);
  db.acceptancePacks[s14.id] = {
    specId: s14.id,
    generatedAt: iso(11 * HOUR),
    summary: "4 张票完成、1 张票已取消，e2e 与终审通过。后端 PR 需先合并（提供契约），前端 PR 保持 draft 直至后端合并。",
    criteria: [
      { id: "ac1", text: "同一订单最多 1 张平台券 + 1 张店铺券", status: "verified", reason: null, evidence: { ticketId: t121.id, ticketDisplayId: t121.displayId, test: "coupon_stacking_test.go::TestMaxOnePerSource" } },
      { id: "ac2", text: "满减券与折扣券互斥", status: "verified", reason: null, evidence: { ticketId: t123.id, ticketDisplayId: t123.displayId, test: "e2e/coupon.spec.ts › exclusive types" } },
      { id: "ac3", text: "冲突时结算页给出原因提示", status: "unverified", reason: "the agent named no test", evidence: null },
    ],
    findings: [f14],
    gate: { tests: 213, skipped: 3, durationMs: 412_000, passed: true },
    risks: ["叠加规则引擎改动了 3 个历史用例的期望值（v3 内容版本）"],
    repositories: [],
  };
  const pack14 = db.acceptancePacks[s14.id];
  if (pack14) {
    const ac1 = pack14.criteria[0];
    const ac2 = pack14.criteria[1];
    const ac3 = pack14.criteria[2];
    if (ac1 && ac2 && ac3) {
      t121.acceptanceCriteria = [ac1]; t123.acceptanceCriteria = [ac2]; t122.acceptanceCriteria = [ac3];
      const unhandled: Finding = { ...f14, id: "fd_14_unhandled", ticketId: t121.id, source: "gate", severity: "major", title: "历史订单券组合未覆盖迁移回归", detail: "新增规则的测试通过，但历史订单迁移场景仍缺少自动化用例，需人工验收。", file: "tests/coupons/legacy_cases.json", line: null, resolution: "unhandled" };
      const fixed: Finding = { ...f14, id: "fd_14_fixed", ticketId: t121.id, title: "重复平台券未及时拒绝", detail: "已增加输入校验与回归测试。", resolution: "fixed" };
      db.findings.push(unhandled, fixed); pack14.findings.push(unhandled, fixed);
      pack14.repositories = [
        { repo: BACKEND, criteria: [{ ...ac1, ticketId: t121.id }], findings: [{ ...unhandled, stage: "gate", kind: "gate" }, { ...fixed, stage: "review-fix", kind: "review" }], uncertainties: [{ id: "unc_14_be", text: "历史订单已保存的组合是否需要重新计算，现有需求未明确。", source: "终审 · 历史订单迁移检查", ticketId: t121.id, runId: f14.runId }], gates: [{ commitSha: db.pullRequests.find(p => p.id === "pr_14_be")?.headSha ?? nextSha(), tests: 149, skipped: 1, durationMs: 242000, steps: [{ name: "setup", exitCode: 0, durationMs: 18000 }, { name: "typecheck", exitCode: 0, durationMs: 14000 }, { name: "test", exitCode: 0, durationMs: 200000 }, { name: "lint", exitCode: 0, durationMs: 10000 }] }], approvedProtectedPaths: [{ ticketId: t121.id, paths: t121.approvedProtectedPaths }] },
        { repo: FRONTEND, criteria: [{ ...ac3, ticketId: t122.id }, { ...ac2, ticketId: t123.id }], findings: [{ ...f14, stage: "final-review", kind: "review" }], uncertainties: [{ id: "unc_14_fe", text: "优惠券互斥提示的业务措辞需要产品确认，agent 无法判断用户是否容易理解。", source: "终审 · 结算页文案", ticketId: t122.id, runId: f14.runId }], gates: [{ commitSha: db.pullRequests.find(p => p.id === "pr_14_fe")?.headSha ?? nextSha(), tests: 64, skipped: 2, durationMs: 170000, steps: [{ name: "setup", exitCode: 0, durationMs: 16000 }, { name: "typecheck", exitCode: 0, durationMs: 18000 }, { name: "test", exitCode: 0, durationMs: 125000 }, { name: "lint", exitCode: 0, durationMs: 11000 }] }], approvedProtectedPaths: [] },
      ];
    }
  }

  /* ---------------- S-15 支付回调重复入账（partially-merged） ---------------- */
  const s15 = spec(15, "payment-callback-dedupe", "支付回调重复入账", "bug", "partially-merged", "支付渠道重复回调导致同一订单入账两次；需要按渠道流水号幂等。");
  const t130 = ticket(s15, 130, BACKEND, "contract", "done", "回调幂等错误码契约", "新增 409 DUPLICATE_CALLBACK。", { contractSha: nextSha() });
  const t131 = ticket(s15, 131, BACKEND, "implementation", "done", "按流水号幂等入账", "唯一索引 + 幂等检查。");
  const t132 = ticket(s15, 132, FRONTEND, "implementation", "done", "后台重复回调标记", "后台订单流水展示重复回调标记。");
  db.edges.push({ from: t130.id, to: t131.id, kind: "blocks" }, { from: t130.id, to: t132.id, kind: "contract" });
  [t130, t131, t132].forEach((t, i) => doneTicketRuns(t, s15, (30 - i) * HOUR));
  db.pullRequests.push(
    { syncError: null, id: "pr_15_be", specId: s15.id, specDisplayId: s15.displayId, repo: BACKEND, number: 476, url: "https://github.com/shop/afk-pilot-backend/pull/476", title: "S-15 支付回调重复入账", state: "closed", draft: false, ci: "failure", review: "changes-requested", headSha: nextSha(), baseBranch: "main", headBranch: s15.integrationBranch, mergedAt: null },
    { syncError: null, id: "pr_15_fe", specId: s15.id, specDisplayId: s15.displayId, repo: FRONTEND, number: 305, url: "https://github.com/shop/afk-pilot-frontend/pull/305", title: "S-15 支付回调重复入账", state: "merged", draft: false, ci: "success", review: "approved", headSha: nextSha(), baseBranch: "main", headBranch: s15.integrationBranch, mergedAt: iso(4 * HOUR) },
  );
  
  db.readyFailures.push({ id: "rf_1", specId: s14.id, specDisplayId: s14.displayId, repo: FRONTEND, step: "mark-ready", error: "GitHub API 422: Pull request #311 base branch protection requires afk-pilot-backend#482 merged first", createdAt: iso(3 * HOUR) });
  const criteria15 = [
    { id: "ac15_be", text: "同一渠道流水号只入账一次", status: "unverified" as const, reason: "历史流水迁移测试失败", evidence: null, ticketId: t131.id },
    { id: "ac15_fe", text: "后台流水显示重复回调标记", status: "verified" as const, reason: null, evidence: { ticketId: t132.id, ticketDisplayId: t132.displayId, test: "payment.spec.ts › duplicate callback badge" }, ticketId: t132.id },
  ];
  db.acceptancePacks[s15.id] = {
    specId: s15.id, generatedAt: iso(5 * HOUR), summary: "前端已合并，但后端 PR 关闭未合并；合并顺序已被打破。后端回归门禁仍失败，请先处理验收风险。", criteria: criteria15, findings: [], risks: ["后端尚未合并，前端已依赖新的回调契约"], gate: { tests: 90, skipped: 1, durationMs: 91000, passed: false },
    repositories: REPOS.map(r => ({ repo: r.name, criteria: criteria15.filter(c => db.tickets.find(t => t.id === c.ticketId)?.repo === r.name), findings: [], uncertainties: [], approvedProtectedPaths: [], gates: [{ commitSha: db.pullRequests.find(p => p.specId === s15.id && p.repo === r.name)?.headSha ?? nextSha(), tests: r.name === BACKEND ? 55 : 35, skipped: r.name === BACKEND ? 1 : 0, durationMs: 91000, steps: [{ name: "setup", exitCode: 0, durationMs: 12000 }, { name: "typecheck", exitCode: 0, durationMs: 9000 }, { name: "test", exitCode: r.name === BACKEND ? 1 : 0, durationMs: 65000 }, { name: "lint", exitCode: 0, durationMs: 5000 }] }] })),
  };

  /* ---------------- S-18 售后退款进度通知（finalizing，终审受阻） ---------------- */
  const s18 = spec(18, "refund-progress-notify", "售后退款进度通知", "feature", "finalizing", "退款状态变化时通知买家，并在订单页展示退款进度。");
  const t160 = ticket(s18, 160, BACKEND, "implementation", "done", "退款状态变更事件", "退款状态机变化时发出事件。");
  const t161 = ticket(s18, 161, FRONTEND, "implementation", "done", "订单页退款进度条", "展示退款进度。");
  db.edges.push({ from: t160.id, to: t161.id, kind: "blocks" });
  [t160, t161].forEach((t, i) => doneTicketRuns(t, s18, (7 - i) * HOUR));
  const e18 = run(null, s18, "final-e2e", "succeeded", 2 * HOUR, "e2e 全部通过", 5 * 60_000);
  const r18 = run(null, s18, "final-review", "failed", 70 * 60_000, "agent 放弃终审", 9 * 60_000);
  db.finalizations.push(
    { repo: null, runDisplayId: null, id: "fin_18_e2e", specId: s18.id, specDisplayId: s18.displayId, step: "final-e2e", state: "done", blockedReason: null, blockedDetail: null, runId: e18.id, updatedAt: iso(HOUR) },
    { repo: BACKEND, runDisplayId: null, id: "fin_18_review", specId: s18.id, specDisplayId: s18.displayId, step: "final-review", state: "blocked", blockedReason: "agent-gave-up", blockedDetail: "agent: 无法判断退款事件的重复投递是否需要幂等处理；\n  契约未说明 at-least-once 语义，放弃终审。", runId: r18.id, updatedAt: iso(60 * 60_000) },
    { repo: null, runDisplayId: null, id: "fin_18_merge", specId: s18.id, specDisplayId: s18.displayId, step: "final-merge", state: "pending", blockedReason: null, blockedDetail: null, runId: null, updatedAt: iso(60 * 60_000) },
  );

  /* ---------------- S-16 会员积分过期提醒（paused） ---------------- */
  const s16 = spec(16, "points-expiry-reminder", "会员积分过期提醒", "feature", "paused", "积分过期前 7 天给会员发送站内信提醒。", { anomalyFrom: "running", pauseReason: "time-budget-exceeded", deadlineAt: new Date(now - 20 * 60_000).toISOString() });
  const t140 = ticket(s16, 140, BACKEND, "implementation", "done", "积分过期扫描任务", "每日扫描 7 天内到期的积分。");
  const t141 = ticket(s16, 141, BACKEND, "implementation", "queued", "站内信发送", "调用消息服务发送提醒。");
  const t142 = ticket(s16, 142, FRONTEND, "implementation", "pending", "积分页过期提示条", "积分页顶部展示即将过期积分。");
  db.edges.push({ from: t140.id, to: t141.id, kind: "blocks" }, { from: t140.id, to: t142.id, kind: "blocks" });
  doneTicketRuns(t140, s16, 9 * HOUR);

  /* ---------------- S-17 商品批量上下架（draft） ---------------- */
  const s17 = spec(17, "bulk-listing", "商品批量上下架", "feature", "draft", "商家可勾选多个商品一键上架/下架，单次最多 500 个。");
  const t150 = ticket(s17, 150, BACKEND, "contract", "pending", "批量上下架契约", "POST /products/bulk-status。", { attempts: 0 });
  const t151 = ticket(s17, 151, BACKEND, "implementation", "pending", "批量状态更新接口", "事务内批量更新。");
  const t152 = ticket(s17, 152, FRONTEND, "implementation", "pending", "商品列表多选与批量操作栏", "多选后底部出现操作栏。");
  db.edges.push({ from: t150.id, to: t151.id, kind: "blocks" }, { from: t150.id, to: t152.id, kind: "contract" });

  /* ---------------- S-11 历史订单查询（merged） ---------------- */
  const s11 = spec(11, "historical-orders", "历史订单查询", "feature", "merged", "支持按日期查询历史订单并查看订单详情。", { updatedAt: iso(5 * 60_000), deadlineAt: null });
  const t90 = ticket(s11, 90, BACKEND, "implementation", "done", "历史订单查询接口", "按日期分页返回历史订单。");
  const t91 = ticket(s11, 91, FRONTEND, "implementation", "done", "历史订单查询页面", "展示历史订单筛选和详情入口。");
  db.edges.push({ from: t90.id, to: t91.id, kind: "blocks" });
  [t90, t91].forEach((t, i) => doneTicketRuns(t, s11, (3 - i) * HOUR));
  run(t107, s12, "implement", "running", 30_000, "正在修复长度校验…");

  const failedImpl = run(t103, s12, "implement", "failed", 2.55 * HOUR, "二次实现仍失败：字数计数 off-by-one", 5 * 60_000, 2);
  failedImpl.id = "run_t103_impl_fail";

  for (const t of db.tickets) {
    const latest = db.versions[t.id]?.find(v => v.version === t.contentVersion);
    if (latest) latest.acceptanceCriteria = structuredClone(t.acceptanceCriteria);
  }
  for (const f of db.finalizations) {
    f.runDisplayId = db.runs.find((r) => r.id === f.runId)?.displayId ?? null;
  }
  for (const s of db.specs) {
    const events: SpecTimelineEvent[] = [];
    if (s.confirmedAt) events.push({ type: "confirmed", at: s.confirmedAt, title: "确认拆分", detail: `${s.displayId} 开始按依赖调度` });
    for (const r of db.runs.filter(r => r.specId === s.id)) {
      const t = db.tickets.find(t => t.id === r.ticketId);
      const href = t ? `/tickets/${t.id}` : `/specs/${s.id}/delivery`;
      if (r.stage === "implement" && t) events.push({ type: "ticket-started", at: r.startedAt, title: `${t.displayId} 开始实现`, detail: t.title, href });
      if (r.stage === "gate" && r.state !== "running") events.push({ type: r.state === "succeeded" ? "gate-passed" : "gate-failed", at: r.finishedAt ?? r.startedAt, title: `${t?.displayId ?? s.displayId} 门禁${r.state === "succeeded" ? "通过" : "失败"}`, detail: r.summary, href });
      if (r.stage === "review") events.push({ type: "review-findings", at: r.finishedAt ?? r.startedAt, title: `${t?.displayId ?? s.displayId} 自审意见 ${db.findings.filter(f => f.runId === r.id).length} 条`, detail: r.summary, href });
      if (r.stage === "merge" && r.state === "succeeded") events.push({ type: "ticket-merged-to-integration", at: r.finishedAt ?? r.startedAt, title: `${t?.displayId} 合并进集成分支`, detail: s.integrationBranch, href });
    }
    for (const t of db.tickets.filter(t => t.specId === s.id)) {
      if (t.state === "blocked") events.push({ type: "ticket-blocked", at: db.runs.find(r => r.id === t.blockedRun?.id)?.finishedAt ?? t.updatedAt, title: `${t.displayId} 受阻`, detail: t.blockedReason ?? "", href: `/tickets/${t.id}` });
      if (t.appended) events.push({ type: "tickets-appended", at: t.updatedAt, title: `追加票 ${t.displayId}`, detail: t.title, href: `/tickets/${t.id}` });
    }
    const finals = db.finalizations.filter(f => f.specId === s.id);
    if (finals.length) events.push({ type: "finalizing-entered", at: db.runs.find(r => r.id === finals[0]?.runId)?.startedAt ?? finals[0]?.updatedAt ?? s.updatedAt, title: "进入收尾" });
    finals.filter(f => f.runId).forEach(f => events.push({ type: "final-step-changed", at: f.updatedAt, title: `收尾步骤变更 · ${f.step}`, detail: `${f.runDisplayId} · ${f.state}`, href: `/specs/${s.id}/delivery` }));
    db.pullRequests.filter(p => p.specId === s.id).forEach(p => events.push({ type: "pr-opened", at: db.acceptancePacks[s.id]?.generatedAt ?? s.updatedAt, title: `开 PR · ${p.repo}#${p.number}`, detail: p.title, href: p.url }));
    const pack = db.acceptancePacks[s.id];
    if (pack) events.push({ type: "acceptance-pack-generated", at: pack.generatedAt, title: "验收包生成", detail: pack.summary, href: `/specs/${s.id}/delivery` });
    if (s.state === "paused") events.push({ type: "paused", at: s.updatedAt, title: "需求暂停", detail: s.pauseReason ?? "" });
    if (s.state === "merged") events.push({ type: "merged-to-main", at: s.updatedAt, title: "合并进 main" });
    db.timelines[s.id] = events;
  }
  return db;
}
