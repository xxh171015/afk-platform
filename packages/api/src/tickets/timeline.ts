import { formatDisplayId } from "@afk/shared";
import type pg from "pg";

// A spec's timeline reconstructed from what the platform recorded: runs, pull requests, the pack, and the spec
// itself. Only the kinds the experience spec listed are emitted
// (docs/specs/experience-platform.md「信息架构」).

export const TIMELINE_KINDS = [
  "confirm-plan",
  "ticket-start",
  "gate",
  "review",
  "ticket-merge",
  "ticket-blocked",
  "finalization",
  "pr-opened",
  "pr-ready",
  "pack",
  "ticket-appended",
  "pause",
  "resume",
  "merged",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineItem {
  kind: TimelineKind;
  at: string;
  text: string;
  runId?: number;
  ticketId?: number;
}

const FINAL_STAGES = new Set([
  "final-review",
  "final-fix",
  "final-merge",
  "final-e2e",
]);

export async function specTimeline(
  pool: pg.Pool,
  specId: number,
): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const spec = (
    await pool.query<{
      state: string;
      pause_reason: string | null;
      created_at: Date;
    }>("SELECT state, pause_reason, created_at FROM specs WHERE id = $1", [
      specId,
    ])
  ).rows[0];
  if (!spec) return [];

  const firstRun = (
    await pool.query<{ started_at: Date | null }>(
      `SELECT started_at FROM runs WHERE spec_id = $1 AND started_at IS NOT NULL
       ORDER BY started_at ASC LIMIT 1`,
      [specId],
    )
  ).rows[0];
  if (spec.state !== "draft" && firstRun?.started_at) {
    items.push({
      kind: "confirm-plan",
      at: firstRun.started_at.toISOString(),
      text: "确认拆分",
    });
  }

  const started = await pool.query<{
    ticket_id: number;
    started_at: Date;
  }>(
    `SELECT DISTINCT ON (ticket_id) ticket_id, started_at
     FROM runs WHERE spec_id = $1 AND ticket_id IS NOT NULL AND started_at IS NOT NULL
     ORDER BY ticket_id, started_at ASC`,
    [specId],
  );
  for (const row of started.rows) {
    items.push({
      kind: "ticket-start",
      at: row.started_at.toISOString(),
      text: `${formatDisplayId("ticket", row.ticket_id)} 开始`,
      ticketId: row.ticket_id,
    });
  }

  const runs = await pool.query<{
    id: number;
    ticket_id: number | null;
    stage: string;
    result: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    findings: string;
  }>(
    `SELECT r.id, r.ticket_id, r.stage, r.result, r.started_at, r.finished_at,
            (SELECT count(*)::text FROM findings f WHERE f.run_id = r.id) AS findings
     FROM runs r WHERE r.spec_id = $1 AND r.result IS NOT NULL
     ORDER BY coalesce(r.finished_at, r.started_at, now())`,
    [specId],
  );
  for (const run of runs.rows) {
    const at = (run.finished_at ?? run.started_at)?.toISOString();
    if (!at) continue;
    const ticket = run.ticket_id
      ? formatDisplayId("ticket", run.ticket_id)
      : null;
    const runRef = {
      runId: run.id,
      ...(run.ticket_id ? { ticketId: run.ticket_id } : {}),
    };
    if (run.stage === "gate") {
      items.push({
        kind: "gate",
        at,
        text: `${ticket ?? "收尾"} 门禁${run.result === "passed" ? "通过" : "失败"}`,
        ...runRef,
      });
    } else if (run.stage === "review") {
      items.push({
        kind: "review",
        at,
        text: `${ticket ?? "spec"} review ${run.findings} 条意见`,
        ...runRef,
      });
    } else if (run.stage === "merge" && run.result === "merged") {
      items.push({
        kind: "ticket-merge",
        at,
        text: `${ticket} 合并进集成分支`,
        ...runRef,
      });
    } else if (FINAL_STAGES.has(run.stage)) {
      items.push({
        kind: "finalization",
        at,
        text: `收尾 ${run.stage} ${run.result ?? ""}`.trim(),
        ...runRef,
      });
    }
  }

  const blocked = await pool.query<{
    id: number;
    blocked_reason: string | null;
    finished_at: Date | null;
  }>(
    `SELECT t.id, t.blocked_reason,
            (SELECT r.finished_at FROM runs r WHERE r.ticket_id = t.id
             ORDER BY r.id DESC LIMIT 1) AS finished_at
     FROM tickets t WHERE t.spec_id = $1 AND t.state = 'blocked'`,
    [specId],
  );
  for (const row of blocked.rows) {
    items.push({
      kind: "ticket-blocked",
      at: (row.finished_at ?? spec.created_at).toISOString(),
      text: `${formatDisplayId("ticket", row.id)} 卡住${row.blocked_reason ? `：${row.blocked_reason}` : ""}`,
      ticketId: row.id,
    });
  }

  const appended = await pool.query<{ id: number; created_at: Date }>(
    "SELECT id, created_at FROM tickets WHERE spec_id = $1 AND appended = true ORDER BY id",
    [specId],
  );
  for (const row of appended.rows) {
    items.push({
      kind: "ticket-appended",
      at: row.created_at.toISOString(),
      text: `${formatDisplayId("ticket", row.id)} 追加`,
      ticketId: row.id,
    });
  }

  const pulls = await pool.query<{
    number: number;
    draft: boolean;
    state: string;
    synced_at: Date;
  }>(
    "SELECT number, draft, state, synced_at FROM pull_requests WHERE spec_id = $1 ORDER BY id",
    [specId],
  );
  for (const pull of pulls.rows) {
    items.push({
      kind: "pr-opened",
      at: pull.synced_at.toISOString(),
      text: `开 PR #${pull.number}`,
    });
    if (!pull.draft)
      items.push({
        kind: "pr-ready",
        at: pull.synced_at.toISOString(),
        text: `PR #${pull.number} 转 ready`,
      });
    if (pull.state === "merged")
      items.push({
        kind: "merged",
        at: pull.synced_at.toISOString(),
        text: `PR #${pull.number} 合并进 main`,
      });
  }

  const pack = (
    await pool.query<{ generated_at: Date }>(
      "SELECT generated_at FROM acceptance_packs WHERE spec_id = $1",
      [specId],
    )
  ).rows[0];
  if (pack)
    items.push({
      kind: "pack",
      at: pack.generated_at.toISOString(),
      text: "验收包生成",
    });

  if (spec.state === "paused")
    items.push({
      kind: "pause",
      at: spec.created_at.toISOString(),
      text: spec.pause_reason ? `暂停：${spec.pause_reason}` : "暂停",
    });

  items.sort(
    (a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind),
  );
  return items;
}
