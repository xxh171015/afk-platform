// PROTOTYPE — 单票流水线的各阶段，每个阶段一个函数。除 sandbox.ts 外都不碰 Sandcastle。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PROTECTED, ensureDir, git, gitOut } from "./config.ts";
import { execInFreshSandbox } from "./sandbox.ts";

export type Ids = { spec: string; ticket: string; run: string };

// ---------- 渲染 /context ----------
export function renderContext(o: {
  dir: string;
  ticketMd: string;
  specMd: string;
  runJson: Record<string, unknown>;
  failure?: string;
  reviewJson?: unknown;
}) {
  ensureDir(o.dir);
  writeFileSync(join(o.dir, "ticket.md"), o.ticketMd);
  writeFileSync(join(o.dir, "spec.md"), o.specMd);
  writeFileSync(join(o.dir, "run.json"), JSON.stringify(o.runJson, null, 2));
  if (o.failure !== undefined) {
    ensureDir(join(o.dir, "failure"));
    writeFileSync(join(o.dir, "failure", "gate.log"), o.failure);
  }
  if (o.reviewJson !== undefined) writeFileSync(join(o.dir, "review.json"), JSON.stringify(o.reviewJson, null, 2));
}

// ---------- 3 补 trailer ----------
/** 给 before..branch 的 commits 补 Spec / Ticket / Run trailer。agent 的 worktree 已被 Sandcastle 删掉，所以另开一个临时 worktree 做 rebase */
export function stampTrailers(branch: string, before: string, ids: Ids, tmpDir: string): { rewritten: number; cursorTrailer: boolean; error?: string } {
  const range = `${before}..${branch}`;
  const n = Number(gitOut(["rev-list", "--count", range]));
  if (n === 0) return { rewritten: 0, cursorTrailer: false };
  const cursorTrailer = /made with cursor|cursoragent/i.test(gitOut(["log", "--format=%B", range]));
  const add = git(["worktree", "add", tmpDir, branch]);
  if (add.code !== 0) return { rewritten: 0, cursorTrailer, error: `worktree add 失败：${add.out}` };
  try {
    const exec = `git commit --amend --no-edit --trailer 'Spec: ${ids.spec}' --trailer 'Ticket: ${ids.ticket}' --trailer 'Run: ${ids.run}'`;
    const rb = git(["rebase", "--rebase-merges", "--exec", exec, before], tmpDir);
    if (rb.code !== 0) {
      git(["rebase", "--abort"], tmpDir);
      return { rewritten: 0, cursorTrailer, error: `rebase 失败：${rb.out.slice(0, 400)}` };
    }
    return { rewritten: n, cursorTrailer };
  } finally {
    git(["worktree", "remove", "--force", tmpDir]);
  }
}

// ---------- 4a 保护路径 ----------
export function protectedPathsTouched(base: string, branch: string): { files: string[]; touched: string[] } {
  const files = gitOut(["diff", "--name-only", `${base}...${branch}`]).split("\n").filter(Boolean);
  return { files, touched: files.filter((f) => PROTECTED.some((p) => f.startsWith(p))) };
}

// ---------- 4b / 7 门禁 ----------
export type GateResult = {
  pass: boolean;
  reasons: string[];
  tests: number;
  skipped: number;
  configSha: string;
  steps: { name: string; exitCode: number; ms: number }[];
  failureLog: string;
};
type GatesYaml = { setup?: string; commands: { name: string; run: string; timeoutSeconds: number; junit?: string }[] };

const gateCache = new Map<string, GateResult>();
export const cachedGate = (sha: string) => gateCache.get(sha);

export function junitCounts(xml: string) {
  const tests = Number(/<testsuites[^>]*\btests="(\d+)"/.exec(xml)?.[1] ?? NaN);
  const skipped = [...xml.matchAll(/<testsuite\s[^>]*\bskipped="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
  return { tests, skipped };
}

/**
 * 在 `branch`（已有的本地分支）上跑门禁。配置取自 configSha，不取自被测分支；
 * 与 baseline（上一个已通过的 GateResult）比较：测试总数不能变少，跳过数不能变多。
 */
export async function runGate(o: { branch: string; configSha: string; baseline?: GateResult; outDir: string; label: string; probe?: boolean }) {
  const yamlText = gitOut(["show", `${o.configSha}:.sandcastle/gates.yaml`]);
  const cfg = parseYaml(yamlText) as GatesYaml;
  const steps = [...(cfg.setup ? [{ name: "setup", run: cfg.setup, timeoutSeconds: 600 }] : []), ...cfg.commands];
  const junitPath = cfg.commands.find((c) => c.junit)?.junit ?? "reports/junit.xml";
  const r = await execInFreshSandbox({ branch: o.branch, steps, junitPath, probe: o.probe });
  const reasons: string[] = [];
  let tests = NaN;
  let skipped = NaN;
  for (const s of r.steps) {
    writeFileSync(join(o.outDir, `gate-${o.label}-${s.name}.log`), s.log);
    if (s.exitCode !== 0) reasons.push(`${s.name} 失败（exit ${s.exitCode}）`);
  }
  if (r.steps.length < steps.length && reasons.length === 0) reasons.push("门禁没有跑完");
  if (r.junit) {
    writeFileSync(join(o.outDir, `gate-${o.label}-junit.xml`), r.junit);
    ({ tests, skipped } = junitCounts(r.junit));
    if (o.baseline) {
      if (tests < o.baseline.tests) reasons.push(`测试总数变少：${tests} < 基线 ${o.baseline.tests}`);
      if (skipped > o.baseline.skipped) reasons.push(`跳过数变多：${skipped} > 基线 ${o.baseline.skipped}`);
    }
  } else if (reasons.length === 0) {
    reasons.push("没有 JUnit 结果");
  }
  const failed = r.steps.find((s) => s.exitCode !== 0);
  const failureLog = failed ? `# ${failed.name} 失败（exit ${failed.exitCode}）\n\n${failed.log.split("\n").slice(-200).join("\n")}\n` : reasons.join("\n");
  const result: GateResult = {
    pass: reasons.length === 0,
    reasons,
    tests,
    skipped,
    configSha: o.configSha,
    steps: r.steps.map((s) => ({ name: s.name, exitCode: s.exitCode, ms: s.ms })),
    failureLog: reasons.length ? `${failureLog}\n## 门禁结论\n${reasons.map((x) => `- ${x}`).join("\n")}\n` : "",
  };
  return { result, probe: r.probe };
}
export function rememberGate(sha: string, r: GateResult) {
  gateCache.set(sha, r);
}

// ---------- 6 合并候选（只用 ref，不 checkout） ----------
export function mergeCandidate(spec: string, agent: string, message: string): { conflict: boolean; candidate?: string; detail?: string } {
  const mt = git(["merge-tree", "--write-tree", spec, agent]);
  if (mt.code === 1) return { conflict: true, detail: mt.out.slice(0, 600) };
  if (mt.code !== 0) throw new Error(`merge-tree 出错：${mt.out}`);
  const tree = mt.stdout.trim().split("\n")[0]!;
  const specSha = gitOut(["rev-parse", spec]);
  const agentSha = gitOut(["rev-parse", agent]);
  const c = git(["commit-tree", tree, "-p", specSha, "-p", agentSha, "-m", message]);
  if (c.code !== 0) throw new Error(`commit-tree 出错：${c.out}`);
  return { conflict: false, candidate: c.stdout.trim() };
}

export const hasRef = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref]).code === 0;
