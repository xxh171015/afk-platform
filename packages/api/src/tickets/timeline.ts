import {
  type FailureSource,
  formatDisplayId,
  type HostKind,
  type HumanAction,
  pauseReasonLabel,
  pullAbbrev,
} from "@afk/shared";
import type pg from "pg";

// A spec's timeline: with events, state changes and a person's actions come from the event table; PR/MR and
// the pack still come from domain tables. With none, the old assembly from runs, PRs, the pack and the spec
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
  "action",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineItem {
  kind: TimelineKind;
  at: string;
  text: string;
  runId?: number;
  ticketId?: number;
  failureSource?: FailureSource;
}

const FINAL_STAGES = new Set([
  "final-review",
  "final-fix",
  "final-merge",
  "final-e2e",
]);

function actionText(action: string, ticketId: number | null): string | null {
  if (action === "confirm") return null;
  const ticket = ticketId ? formatDisplayId("ticket", ticketId) : null;
  switch (action as HumanAction) {
    case "retry":
      return ticket ? `重试 ${ticket}` : "重试";
    case "allow":
      return "放行";
    case "cancel-ticket":
      return ticket ? `取消 ${ticket}` : "取消票";
    case "cancel-spec":
      return "取消需求";
    case "approve-protected":
      return ticket ? `批准保护路径 ${ticket}` : "批准保护路径";
    case "approve-removed-tests":
      return ticket ? `批准删掉的测试 ${ticket}` : "批准删掉的测试";
    case "allow-paths":
      return ticket ? `批准路径 ${ticket}` : "批准路径";
    case "edit-ticket":
      return ticket ? `改票 ${ticket}` : "改票";
    case "retry-final":
      return "重试收尾";
    case "waive-final":
      return "放行收尾";
    case "retry-cleanup":
      return "重试清理";
    case "retry-planning":
      return "重试规划";
    case "waive-planning":
      return "放行规划";
    case "takeover":
      return ticket ? `人接手 ${ticket}` : "人接手";
    case "handback":
      return ticket ? `交回 ${ticket}` : "交回";
    default:
      return action;
  }
}

export async function specTimeline(
  pool: pg.Pool,
  specId: number,
): Promise<{ items: TimelineItem[]; legacy: boolean }> {
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
  if (!spec) return { items: [], legacy: true };
  const hasEvents =
    (
      await pool.query("SELECT 1 FROM events WHERE spec_id = $1 LIMIT 1", [
        specId,
      ])
    ).rows.length > 0;

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

  if (hasEvents) {
    const blockedHistory = await pool.query<{
      ticket_id: number;
      at: Date;
      reason: string | null;
      failure_source: FailureSource | null;
      run_id: number | null;
    }>(
      `SELECT ticket_id, at, reason, failure_source, run_id
       FROM events
       WHERE spec_id = $1 AND type = 'ticket' AND to_state = 'blocked'
       ORDER BY id`,
      [specId],
    );
    for (const row of blockedHistory.rows) {
      items.push({
        kind: "ticket-blocked",
        at: row.at.toISOString(),
        text: `${formatDisplayId("ticket", row.ticket_id)} 卡住${row.reason ? `：${row.reason}` : ""}`,
        ticketId: row.ticket_id,
        ...(row.run_id ? { runId: row.run_id } : {}),
        ...(row.failure_source ? { failureSource: row.failure_source } : {}),
      });
    }
  } else {
    const blockedSources = new Map<number, FailureSource>();
    const blockedEvents = await pool.query<{
      ticket_id: number;
      failure_source: FailureSource | null;
    }>(
      `SELECT DISTINCT ON (ticket_id) ticket_id, failure_source
       FROM events
       WHERE spec_id = $1 AND type = 'ticket' AND to_state = 'blocked'
       ORDER BY ticket_id, id DESC`,
      [specId],
    );
    for (const row of blockedEvents.rows) {
      if (row.failure_source)
        blockedSources.set(row.ticket_id, row.failure_source);
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
        ...(blockedSources.get(row.id)
          ? { failureSource: blockedSources.get(row.id) }
          : {}),
      });
    }
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
    host_kind: HostKind;
  }>(
    `SELECT p.number, p.draft, p.state, p.synced_at, r.host_kind
     FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.spec_id = $1 ORDER BY p.id`,
    [specId],
  );
  for (const pull of pulls.rows) {
    const pr = pullAbbrev(pull.host_kind);
    items.push({
      kind: "pr-opened",
      at: pull.synced_at.toISOString(),
      text: `开 ${pr} #${pull.number}`,
    });
    if (!pull.draft)
      items.push({
        kind: "pr-ready",
        at: pull.synced_at.toISOString(),
        text: `${pr} #${pull.number} 转 ready`,
      });
    if (pull.state === "merged")
      items.push({
        kind: "merged",
        at: pull.synced_at.toISOString(),
        text: `${pr} #${pull.number} 合并进 main`,
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

  if (hasEvents) {
    const pauses = await pool.query<{
      at: Date;
      reason: string | null;
      failure_source: FailureSource | null;
    }>(
      `SELECT at, reason, failure_source FROM events
       WHERE spec_id = $1 AND type = 'spec' AND to_state = 'paused'
       ORDER BY id`,
      [specId],
    );
    for (const pause of pauses.rows) {
      items.push({
        kind: "pause",
        at: pause.at.toISOString(),
        text: pause.reason ? `暂停：${pauseReasonLabel(pause.reason)}` : "暂停",
        ...(pause.failure_source
          ? { failureSource: pause.failure_source }
          : {}),
      });
    }
    const resumes = await pool.query<{ at: Date }>(
      `SELECT at FROM events
       WHERE spec_id = $1 AND type = 'spec' AND from_state = 'paused'
         AND to_state IS DISTINCT FROM 'cancelled'
       ORDER BY id`,
      [specId],
    );
    for (const resume of resumes.rows) {
      items.push({
        kind: "resume",
        at: resume.at.toISOString(),
        text: "恢复",
      });
    }
    const actions = await pool.query<{
      at: Date;
      ticket_id: number | null;
      data: { action?: string };
    }>(
      `SELECT at, ticket_id, data FROM events
       WHERE spec_id = $1 AND type = 'action'
       ORDER BY id`,
      [specId],
    );
    for (const row of actions.rows) {
      const action = row.data?.action;
      if (!action) continue;
      const text = actionText(action, row.ticket_id);
      if (!text) continue;
      items.push({
        kind: "action",
        at: row.at.toISOString(),
        text,
        ...(row.ticket_id ? { ticketId: row.ticket_id } : {}),
      });
    }
  } else if (spec.state === "paused") {
    const pause = (
      await pool.query<{ at: Date; failure_source: FailureSource | null }>(
        `SELECT at, failure_source FROM events
         WHERE spec_id = $1 AND type = 'spec' AND to_state = 'paused'
         ORDER BY id DESC LIMIT 1`,
        [specId],
      )
    ).rows[0];
    items.push({
      kind: "pause",
      at: (pause?.at ?? spec.created_at).toISOString(),
      text: spec.pause_reason
        ? `暂停：${pauseReasonLabel(spec.pause_reason)}`
        : "暂停",
      ...(pause?.failure_source ? { failureSource: pause.failure_source } : {}),
    });
  }

  items.sort(
    (a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind),
  );
  return { items, legacy: !hasEvents };
}
