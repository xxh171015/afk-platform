import { formatDuration } from "./time";
import type { AcceptancePack, AcceptanceRepository, PullRequest, SpecDetailResponse } from "@/api/types";

export function prWaitsFor(pr: PullRequest, detail: SpecDetailResponse): string[] {
  if (pr.state === "merged") return [];
  return pr.waitsFor ?? (detail.mergeOrder.after[pr.repo] ?? []).filter(repo => !detail.pullRequests.some(p => p.repo === repo && p.state === "merged"));
}
export function mergeOrderSentence(detail: SpecDetailResponse) {
  const ordered = detail.mergeOrder.ordered;
  const unordered = detail.mergeOrder.unordered;
  return [ordered.length ? `合并顺序：${ordered.join(" → ")}` : "没有契约顺序约束", unordered.length ? `${unordered.join("、")} 不分先后` : ""].filter(Boolean).join("；");
}
export function acceptanceStats(pack: AcceptancePack) {
  return { verified: pack.criteria.filter(c => c.status === "verified").length, total: pack.criteria.length, unhandled: pack.findings.filter(f => f.resolution === "unhandled").length };
}
export function reportRepositories(detail: SpecDetailResponse): AcceptanceRepository[] {
  const pack = detail.acceptancePack;
  if (!pack) return [];
  const names = [...new Set([...detail.spec.repos.map(r => r.name), ...pack.repositories.map(r => r.repo)])];
  return names.map(repo => pack.repositories.find(r => r.repo === repo) ?? { repo, criteria: [], findings: [], uncertainties: [], gates: [], approvedProtectedPaths: [] });
}
export const milliseconds = formatDuration;
export function exportAcceptanceMarkdown(detail: SpecDetailResponse): string {
  const pack = detail.acceptancePack;
  if (!pack) return "";
  const stats = acceptanceStats(pack);
  const ticketLabel = (id: string | null) => detail.tickets.find(t => t.id === id)?.displayId ?? detail.spec.displayId;
  const lines = [`# ${detail.spec.displayId} ${detail.spec.title} · 验收包`, "", pack.summary, "", mergeOrderSentence(detail), "", "按这个顺序合并，平台从不自动合并。", ...detail.orderBroken.map(b => `> 警告：${b.repo} 在 ${b.skipped.join("、")} 之前被合并了。`), "", `验收标准：${stats.verified}/${stats.total} verified；未处理意见：${stats.unhandled}；agent 总用时：${formatDuration(detail.agentUsedSeconds * 1000)}`, ""];
  if (pack.risks.length) lines.push("## 风险提示", ...pack.risks.map(r => `- ${r}`), "");
  for (const r of reportRepositories(detail)) {
    lines.push(`## ${r.repo}`, "", "### PR");
    const prs = detail.pullRequests.filter(p => p.repo === r.repo);
    if (!prs.length) lines.push("尚无 PR");
    for (const p of prs) {
      lines.push(`- [#${p.number}](${p.url}) · ${p.state === "closed" ? "closed（关闭未合并）" : p.state} · ${p.draft ? "draft" : "ready"} · CI: ${p.ci} · review: ${p.review}`);
      const waits = prWaitsFor(p, detail);
      if (waits.length) lines.push(`  - 等待：${waits.join("、")} 合并`);
      if (p.syncError) lines.push(`  - 读取失败：${p.syncError}`);
    }
    lines.push("", "### 验收标准");
    for (const t of detail.tickets.filter(t => t.repo === r.repo && t.state !== "cancelled")) {
      lines.push(`#### ${t.displayId} ${t.title}${t.appended ? "（追加）" : ""}`);
      const criteria = r.criteria.filter(c => c.ticketId === t.id);
      if (!criteria.length) lines.push("- 尚无验收标准记录");
      for (const c of criteria) lines.push(`- ${c.status === "verified" ? "[x]" : "[ ]"} ${c.text} · ${c.status}${c.evidence ? ` · 测试：\`${c.evidence.test}\`` : ""}${c.status === "unverified" ? ` · 原因：${c.reason ?? "未提供原因"}` : ""}`);
    }
    lines.push("", "### 意见");
    for (const resolution of ["unhandled", "acceptance-pack", "fixed"] as const) {
      lines.push(`#### ${resolution}`);
      const findings = r.findings.filter(f => f.resolution === resolution);
      if (!findings.length) lines.push("无");
      for (const f of findings) lines.push(`- ${ticketLabel(f.ticketId)} · stage: \`${f.stage}\` · kind: \`${f.kind}\` · ${f.title}`, `  ${f.detail}`);
    }
    lines.push("", "### agent 不确定的地方");
    if (!r.uncertainties.length) lines.push("无记录");
    for (const u of r.uncertainties) lines.push(`> ${u.text.replaceAll("\n", "\n> ")}`, `> 来源：${u.source} · ${ticketLabel(u.ticketId)}${u.runId ? ` · ${detail.runs.find(run => run.id === u.runId)?.displayId ?? u.runId}` : ""}`, "");
    lines.push("", "### 门禁");
    if (!r.gates.length) lines.push("尚无门禁记录");
    for (const g of r.gates) {
      lines.push(`commit: \`${g.commitSha}\` · 测试 ${g.tests} · 跳过 ${g.skipped} · 总耗时 ${milliseconds(g.durationMs)}`, "", "| 步骤 | 耗时 | exit code |", "| --- | --- | --- |");
      for (const s of g.steps) lines.push(`| ${s.name} | ${milliseconds(s.durationMs)} | ${s.exitCode ?? "未结束"} |`);
    }
    lines.push("", "### 已批准的保护路径");
    if (!r.approvedProtectedPaths.length) lines.push("无记录");
    for (const a of r.approvedProtectedPaths) lines.push(`- ${ticketLabel(a.ticketId)}（人工放行的风险点）`, ...a.paths.map(p => `  - \`${p}\``));
    lines.push("");
  }
  lines.push("## 已取消的票");
  const cancelled = detail.tickets.filter(t => t.state === "cancelled");
  lines.push(...(cancelled.length ? cancelled.map(t => `- ~~${t.displayId} ${t.title}~~ · ${t.repo}`) : ["无"]));
  return lines.join("\n");
}