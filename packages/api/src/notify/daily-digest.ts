import {
  formatDisplayId,
  type HostKind,
  METRICS_TIME_ZONE,
  pullAbbrev,
  ymdInZone,
} from "@afk/shared";
import type pg from "pg";
import { recordSystemEvent } from "../events/system.ts";

// Morning report of awaiting-review / partially-merged specs, one system event per project
// (docs/optimization-plan.md 8.6). Claimed on instance.digest_sent_on so a pass and a restart
// send at most once per Beijing calendar day.

export const DIGEST_HOUR = 9;
export const DIGEST_EVERY_MS = 5 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  return `${Math.round(ms / HOUR)} 小时`;
}

interface PendingSpec {
  id: number;
  project_id: number;
  title: string;
  opened_at: Date | null;
  pulls: { url: string; conflicts: boolean }[] | null;
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
    `SELECT s.id, s.project_id, s.title,
            (SELECT min(e.at) FROM events e
              WHERE e.spec_id = s.id AND e.type = 'spec' AND e.to_state = 'awaiting-review'
            ) AS opened_at,
            (SELECT json_agg(json_build_object('url', p.url, 'conflicts', p.conflicts_with_default) ORDER BY p.id)
               FROM pull_requests p WHERE p.spec_id = s.id) AS pulls,
            ap.content AS pack,
            (SELECT r.host_kind FROM repos r
              WHERE r.project_id = s.project_id ORDER BY r.id LIMIT 1) AS host_kind
     FROM specs s
     LEFT JOIN acceptance_packs ap ON ap.spec_id = s.id
     WHERE s.state IN ('awaiting-review', 'partially-merged')
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
      const items = spec.pack?.needsDecision ?? [];
      const needsHuman = items.filter(
        (item) => item.kind === "needs-human",
      ).length;
      const deferred = items.filter((item) => item.kind === "deferred").length;
      const opened = spec.opened_at
        ? openedAgo(Math.max(0, now.getTime() - spec.opened_at.getTime()))
        : "不到 1 分钟";
      const urls = pulls.map((pull) => pull.url).filter(Boolean);
      const conflicts = pulls.some((pull) => pull.conflicts);
      return [
        formatDisplayId("spec", spec.id),
        spec.title,
        ...urls,
        `${pr} 开出 ${opened}`,
        `needs-human ${needsHuman}`,
        `deferred ${deferred}`,
        ...(conflicts ? ["与默认分支冲突"] : []),
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
