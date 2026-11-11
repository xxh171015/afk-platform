import {
  formatDisplayId,
  type HostKind,
  pauseReasonLabel,
  pullAbbrev,
  structuredBrief,
} from "@afk/shared";
import type pg from "pg";
import type { EventRow } from "../events/hub.ts";
import { mergeOrderOf } from "../host/merge-order.ts";
import { pageUrl } from "../page-url.ts";
import { composeNotice, type Notice, type NoticeDraft } from "./notices.ts";

export interface MappedNotice {
  draft?: NoticeDraft;
  notice: Notice;
  hostKind: HostKind;
  projectId?: number;
  specId?: number;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function blockedSummary(
  reason: string | null,
  specDisplayId: string,
  ticketDisplayId?: string,
): string {
  if (!reason) return "已卡住";
  return structuredBrief({
    reason,
    specDisplayId,
    ticketDisplayId,
    brief: null,
  }).summary;
}

async function specContext(
  pool: pg.Pool,
  specId: number,
): Promise<{
  title: string;
  state: string;
  projectId: number;
  hostKind: HostKind;
} | null> {
  const { rows } = await pool.query<{
    title: string;
    state: string;
    project_id: number;
    host_kind: string | null;
  }>(
    `SELECT s.title, s.state, s.project_id,
            (SELECT r.host_kind FROM repos r WHERE r.project_id = s.project_id ORDER BY r.id LIMIT 1) AS host_kind
     FROM specs s WHERE s.id = $1`,
    [specId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    title: row.title,
    state: row.state,
    projectId: row.project_id,
    hostKind: row.host_kind === "gitlab" ? "gitlab" : "github",
  };
}

function mapped(
  draft: NoticeDraft,
  hostKind: HostKind,
  projectId?: number,
  specId?: number,
): MappedNotice {
  return {
    draft,
    notice: composeNotice(draft, hostKind),
    hostKind,
    projectId,
    specId,
  };
}

export async function noticeFromEvent(
  pool: pg.Pool,
  event: EventRow,
): Promise<MappedNotice | undefined> {
  if (event.type === "system") return systemNotice(asRecord(event.data));

  if (event.type === "ticket") {
    if (event.toState !== "blocked" || event.fromState === "blocked")
      return undefined;
    if (event.specId == null || event.ticketId == null) return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec) return undefined;
    const ticket = await pool.query<{ title: string }>(
      "SELECT title FROM tickets WHERE id = $1",
      [event.ticketId],
    );
    const title = ticket.rows[0]?.title;
    if (!title) return undefined;
    const specDisplay = formatDisplayId("spec", event.specId);
    const ticketDisplay = formatDisplayId("ticket", event.ticketId);
    return mapped(
      {
        kind: "ticket-blocked",
        displayId: ticketDisplay,
        title,
        reason: blockedSummary(event.reason, specDisplay, ticketDisplay),
        path: `/tickets/${event.ticketId}`,
      },
      spec.hostKind,
      spec.projectId,
      event.specId,
    );
  }

  if (event.type === "finalization" || event.type === "final-e2e") {
    if (event.toState !== "blocked" || event.fromState === "blocked")
      return undefined;
    if (event.specId == null) return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec) return undefined;
    const specDisplay = formatDisplayId("spec", event.specId);
    return mapped(
      {
        kind: "final-blocked",
        displayId: specDisplay,
        title: spec.title,
        reason: blockedSummary(event.reason, specDisplay),
        path: `/specs/${event.specId}/delivery`,
      },
      spec.hostKind,
      spec.projectId,
      event.specId,
    );
  }

  if (event.type === "spec") {
    if (event.specId == null) return undefined;
    const data = asRecord(event.data);
    const tokenMerged = data.tokenMerged === true;
    const paused =
      event.toState === "paused" &&
      event.fromState != null &&
      event.fromState !== "paused";
    const awaiting =
      event.toState === "awaiting-review" &&
      event.fromState != null &&
      event.fromState !== "awaiting-review";
    const merged =
      event.toState === "merged" &&
      event.fromState != null &&
      event.fromState !== "merged";
    if (!tokenMerged && !paused && !awaiting && !merged) return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec) return undefined;
    if (tokenMerged) {
      const pr = pullAbbrev(spec.hostKind);
      return mapped(
        {
          kind: "waiting-other",
          displayId: formatDisplayId("spec", event.specId),
          title: spec.title,
          reason: `平台账号合并了 ${pr}`,
          path: `/specs/${event.specId}/delivery`,
        },
        spec.hostKind,
        spec.projectId,
        event.specId,
      );
    }
    if (paused) {
      return mapped(
        {
          kind: "spec-paused",
          displayId: formatDisplayId("spec", event.specId),
          title: spec.title,
          reason: pauseReasonLabel(event.reason),
          path: `/specs/${event.specId}`,
        },
        spec.hostKind,
        spec.projectId,
        event.specId,
      );
    }
    if (awaiting) {
      const pr = pullAbbrev(spec.hostKind);
      return mapped(
        {
          kind: "awaiting-review",
          displayId: formatDisplayId("spec", event.specId),
          title: spec.title,
          reason: `验收包和 ${pr} 已齐`,
          path: `/specs/${event.specId}/delivery`,
        },
        spec.hostKind,
        spec.projectId,
        event.specId,
      );
    }
    if (merged) {
      return mapped(
        {
          kind: "spec-merged",
          displayId: formatDisplayId("spec", event.specId),
          title: spec.title,
          reason: "已全部合并",
          path: `/specs/${event.specId}`,
        },
        spec.hostKind,
        spec.projectId,
        event.specId,
      );
    }
    return undefined;
  }

  if (event.type === "pull-request-draft") {
    if (
      event.fromState !== "true" ||
      event.toState !== "false" ||
      event.specId == null ||
      event.repoId == null
    )
      return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec) return undefined;
    const repo = await pool.query<{ name: string }>(
      "SELECT name FROM repos WHERE id = $1",
      [event.repoId],
    );
    const repoName = repo.rows[0]?.name;
    if (!repoName) return undefined;
    const order = await mergeOrderOf(pool, event.specId);
    if ((order.after[repoName] ?? []).length === 0) return undefined;
    return mapped(
      {
        kind: "pr-ready",
        displayId: formatDisplayId("spec", event.specId),
        title: spec.title,
        reason: `${repoName} 的草稿已转 ready`,
        path: `/specs/${event.specId}/delivery`,
      },
      spec.hostKind,
      spec.projectId,
      event.specId,
    );
  }

  if (event.type === "pull-request") {
    if (event.toState !== "closed" || event.specId == null) return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec || spec.state === "merged" || spec.state === "cancelled")
      return undefined;
    const pr = pullAbbrev(spec.hostKind);
    return mapped(
      {
        kind: "waiting-other",
        displayId: formatDisplayId("spec", event.specId),
        title: spec.title,
        reason: `${pr} 被关`,
        path: "/waiting",
      },
      spec.hostKind,
      spec.projectId,
      event.specId,
    );
  }

  if (event.type === "pull-request-sync") {
    if (event.toState !== "error" || event.specId == null) return undefined;
    const spec = await specContext(pool, event.specId);
    if (!spec || spec.state === "merged" || spec.state === "cancelled")
      return undefined;
    const pr = pullAbbrev(spec.hostKind);
    return mapped(
      {
        kind: "waiting-other",
        displayId: formatDisplayId("spec", event.specId),
        title: spec.title,
        reason: `${pr} 读不出`,
        path: "/waiting",
      },
      spec.hostKind,
      spec.projectId,
      event.specId,
    );
  }

  if (event.type === "job") {
    const data = asRecord(event.data);
    if (event.toState !== "failed") return undefined;
    if (data.jobType === "spec-cleanup") {
      if (event.specId == null || event.jobId == null) return undefined;
      const terminal = await pool.query(
        `SELECT 1 FROM jobs j
         WHERE j.id = $1 AND j.type = 'spec-cleanup' AND j.state = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM jobs k WHERE k.type = 'spec-cleanup'
               AND (k.payload->>'specId')::int = (j.payload->>'specId')::int
               AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))`,
        [event.jobId],
      );
      if (!terminal.rows[0]) return undefined;
      const spec = await specContext(pool, event.specId);
      if (!spec) return undefined;
      return mapped(
        {
          kind: "waiting-other",
          displayId: formatDisplayId("spec", event.specId),
          title: spec.title,
          reason: "清理失败",
          path: "/waiting",
        },
        spec.hostKind,
        spec.projectId,
        event.specId,
      );
    }
    if (data.jobType === "pr-ready" && event.jobId != null) {
      const job = await pool.query<{
        pull_id: number | null;
        spec_id: number | null;
        title: string | null;
        draft: boolean | null;
        spec_state: string | null;
        project_id: number | null;
        host_kind: string | null;
      }>(
        `SELECT (j.payload->>'pullId')::int AS pull_id, p.spec_id, s.title, p.draft, s.state AS spec_state,
                s.project_id,
                (SELECT r.host_kind FROM repos r WHERE r.project_id = s.project_id ORDER BY r.id LIMIT 1) AS host_kind
         FROM jobs j
         LEFT JOIN pull_requests p ON p.id = (j.payload->>'pullId')::int
         LEFT JOIN specs s ON s.id = p.spec_id
         WHERE j.id = $1 AND j.type = 'pr-ready' AND j.state = 'failed' AND p.draft
           AND NOT EXISTS (
             SELECT 1 FROM jobs k WHERE k.type = 'pr-ready'
               AND (k.payload->>'pullId')::int = (j.payload->>'pullId')::int
               AND k.id > j.id AND k.state IN ('queued', 'running', 'done'))`,
        [event.jobId],
      );
      const row = job.rows[0];
      if (!row?.spec_id || !row.title) return undefined;
      const hostKind: HostKind =
        row.host_kind === "gitlab" ? "gitlab" : "github";
      return mapped(
        {
          kind: "waiting-other",
          displayId: formatDisplayId("spec", row.spec_id),
          title: row.title,
          reason: "转 ready 三次失败",
          path: "/waiting",
        },
        hostKind,
        row.project_id ?? undefined,
        row.spec_id,
      );
    }
    return undefined;
  }

  return undefined;
}

function systemNotice(data: Record<string, unknown>): MappedNotice | undefined {
  const kind = data.kind;
  if (kind === "disk-warn") {
    return {
      notice: {
        title: "磁盘空间不足",
        body: `剩余不足 ${String(data.warnGib)} GiB\n${pageUrl("/")}`,
      },
      hostKind: "github",
    };
  }
  if (kind === "disk-stop") {
    return {
      notice: {
        title: "磁盘空间严重不足",
        body: `剩余不足 ${String(data.stopGib)} GiB，worker 已停止领取新作业\n${pageUrl("/")}`,
      },
      hostKind: "github",
    };
  }
  if (kind === "agents-paused") {
    const reason = typeof data.reason === "string" ? data.reason : "";
    return {
      notice: {
        title: "Agent 已暂停",
        body: `${reason}\n恢复后在页面上点「恢复」，或运行 plat agents resume\n${pageUrl("/")}`,
      },
      hostKind: "github",
    };
  }
  if (kind === "token-expiry") {
    const host = typeof data.host === "string" ? data.host : "";
    const date = typeof data.date === "string" ? data.date : "";
    const daysLeft =
      typeof data.daysLeft === "number" ? data.daysLeft : Number(data.daysLeft);
    const remain =
      daysLeft < 0
        ? `${host} 的个人令牌已于 ${date} 过期`
        : `${host} 的个人令牌将在 ${date} 到期（还剩 ${daysLeft} 天）`;
    return {
      notice: {
        title: "GitLab 令牌即将到期",
        body: `${remain}：换令牌后放到 ~/.afk/secrets/gitlab/${host}，不用重启 worker\n${pageUrl("/")}`,
      },
      hostKind: "github",
    };
  }
  return undefined;
}
