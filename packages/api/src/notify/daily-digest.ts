import {
  formatDisplayId,
  type HostKind,
  METRICS_TIME_ZONE,
  pullAbbrev,
  ymdInZone,
} from "@afk/shared";
import type pg from "pg";
import { recordSystemEvent } from "../events/system.ts";

// Morning report of the Review queue (awaiting-review, partially-merged, reworking,
// and finalizing that once was awaiting-review). First wrap-up stays out. One system event per project
// (docs/optimization-plan.md 8.6). Claimed on instance.digest_sent_on so a pass and a restart
// send at most once per Beijing calendar day.

export const DIGEST_HOUR = 9;
export const DIGEST_EVERY_MS = 5 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function hourInZone(at: Date, timeZone = METRICS_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0");
}

function openedAgo(ms: number): string {
  if (ms < MINUTE) return "不到 1 分钟";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} 分钟`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} 小时`;
  return `${Math.round(ms / DAY)} 天`;
}

interface PendingSpec {
  id: number;
  project_id: number;
  title: string;
  state: string;
  opened_at: Date | null;
  pulls: { url: string; conflicts: boolean; state: string }[] | null;
  pack: { needsDecision?: { kind?: string }[] } | null;
  host_kind: string | null;
}

export async function maybeSendDailyDigest(
  pool: pg.Pool,
  now: Date,
): Promise<void> {
  if (hourInZone(now) < DIGEST_HOUR) return;
  const day = ymdInZone(now);
  const claimed = await pool.query(
    `UPDATE instance SET digest_sent_on = $1
     WHERE digest_sent_on IS DISTINCT FROM $1
     RETURNING singleton`,
    [day],
  );
  if (!claimed.rowCount) return;

  const pending = await pool.query<PendingSpec>(
    `SELECT s.id, s.project_id, s.title, s.state,
            COALESCE(
              (SELECT min(e.at) FROM events e
                WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'awaiting-review'),
              (SELECT min(p.created_at) FROM pull_requests p WHERE p.spec_id = s.id)
            ) AS opened_at,
            (SELECT json_agg(json_build_object('url', p.url, 'conflicts', p.conflicts_with_default, 'state', p.state) ORDER BY p.id)
               FROM pull_requests p WHERE p.spec_id = s.id) AS pulls,
            ap.content AS pack,
            (SELECT r.host_kind FROM repos r
              WHERE r.project_id = s.project_id ORDER BY r.id LIMIT 1) AS host_kind
     FROM specs s
     LEFT JOIN acceptance_packs ap ON ap.spec_id = s.id
     WHERE s.state IN ('awaiting-review', 'partially-merged', 'reworking')
        OR (
          s.state = 'finalizing'
          AND EXISTS (
            SELECT 1 FROM events e
            WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'awaiting-review'
          )
        )
     ORDER BY s.project_id, s.id`,
  );
  const byProject = new Map<number, PendingSpec[]>();
  for (const row of pending.rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }

  for (const [projectId, specs] of byProject) {
    const hostKind: HostKind =
      specs[0]?.host_kind === "gitlab" ? "gitlab" : "github";
    const pr = pullAbbrev(hostKind);
    const lines = specs.map((spec) => {
      const pulls = spec.pulls ?? [];
      const urls = pulls.map((pull) => pull.url).filter(Boolean);
      if (spec.state === "reworking" || spec.state === "finalizing") {
        return [
          formatDisplayId("spec", spec.id),
          spec.title,
          ...urls,
          "返工中",
        ].join(" ");
      }
      const items = spec.pack?.needsDecision ?? [];
      const needsHuman = items.filter(
        (item) => item.kind === "needs-human",
      ).length;
      const deferred = items.filter((item) => item.kind === "deferred").length;
      const openedMs = spec.opened_at
        ? Math.max(0, now.getTime() - spec.opened_at.getTime())
        : null;
      const opened = openedMs === null ? "不到 1 分钟" : openedAgo(openedMs);
      const allClosed =
        pulls.length > 0 && pulls.every((pull) => pull.state === "closed");
      const stale =
        !allClosed && openedMs !== null && openedMs > 7 * DAY
          ? `已等 ${Math.round(openedMs / DAY)} 天，合并或取消`
          : null;
      const conflicts = pulls.some((pull) => pull.conflicts);
      return [
        formatDisplayId("spec", spec.id),
        spec.title,
        ...urls,
        `${pr} 开出 ${opened}`,
        ...(allClosed
          ? ["PR 已全部关闭，可以取消需求"]
          : [`needs-human ${needsHuman}`, `deferred ${deferred}`]),
        ...(conflicts ? ["与默认分支冲突"] : []),
        ...(stale ? [stale] : []),
      ].join(" ");
    });
    await recordSystemEvent(pool, {
      kind: "daily-digest",
      projectId,
      hostKind,
      body: lines.join("\n"),
    });
  }
}
