import type { DoctorItem, DoctorReport } from "@afk/shared";
import type pg from "pg";

export async function putDoctorReport(
  pool: pg.Pool,
  projectId: number,
  machine: string,
  items: DoctorItem[],
  now: Date = new Date(),
): Promise<{ ok: true; report: DoctorReport } | { ok: false }> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    projectId,
  ]);
  if (project.rowCount === 0) return { ok: false };
  await pool.query(
    `INSERT INTO doctor_reports (project_id, machine, checked_at, items)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (project_id, machine)
     DO UPDATE SET checked_at = EXCLUDED.checked_at, items = EXCLUDED.items`,
    [projectId, machine, now, JSON.stringify(items)],
  );
  return {
    ok: true,
    report: { machine, checkedAt: now.toISOString(), items },
  };
}

export async function getDoctorReport(
  pool: pg.Pool,
  projectId: number,
): Promise<
  { status: "no-project" } | { status: "ok"; report: DoctorReport | null }
> {
  const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
    projectId,
  ]);
  if (project.rowCount === 0) return { status: "no-project" };
  const { rows } = await pool.query<{
    machine: string;
    checked_at: Date;
    items: DoctorItem[];
  }>(
    `SELECT machine, checked_at, items FROM doctor_reports
     WHERE project_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  if (!row) return { status: "ok", report: null };
  return {
    status: "ok",
    report: {
      machine: row.machine,
      checkedAt: row.checked_at.toISOString(),
      items: row.items,
    },
  };
}
