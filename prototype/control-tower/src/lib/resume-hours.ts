// 「追加 agent 时间」输入校验：步长 0.5 小时，范围 (0, 168]，提交时换算成整数秒。
export const MAX_RESUME_HOURS = 168;
export const RESUME_STEP_HOURS = 0.5;

export type ResumeHoursResult = { ok: true; hours: number; seconds: number } | { ok: false; error: string };

export function parseResumeHours(raw: string): ResumeHoursResult {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "请输入要追加的小时数" };
  const h = Number(text);
  if (!Number.isFinite(h)) return { ok: false, error: "请输入数字" };
  if (h <= 0) return { ok: false, error: "必须大于 0" };
  if (h > MAX_RESUME_HOURS) return { ok: false, error: `最多追加 ${MAX_RESUME_HOURS} 小时` };
  if (Math.abs(h / RESUME_STEP_HOURS - Math.round(h / RESUME_STEP_HOURS)) > 1e-9) {
    return { ok: false, error: "以 0.5 小时为单位" };
  }
  return { ok: true, hours: h, seconds: Math.round(h * 3600) };
}
