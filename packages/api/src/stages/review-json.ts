import {
  type AxisReview,
  combinedReview,
  REVIEW_AXES,
  type ReviewAxis,
} from "@afk/shared";
import type pg from "pg";

// What a fix reads as /context/review.json: the newest result of each axis that ran, side by side with every
// must-fix and the axis it came from (ADR 0002). An axis that did not run is omitted. A review made before there
// were two axes is handed over as it was.
// `where` picks the review's Runs, e.g. "ticket_id = $1 AND stage = 'review'".
export async function reviewJsonOf(
  pool: pg.Pool,
  where: string,
  params: unknown[],
): Promise<unknown> {
  const { rows } = await pool.query<{
    axis: string | null;
    output: AxisReview;
  }>(
    `SELECT axis, output FROM runs WHERE ${where} AND output->>'verdict' IS NOT NULL ORDER BY id DESC`,
    params,
  );
  const newest = new Map<string, AxisReview>();
  for (const row of rows)
    if (row.axis && !newest.has(row.axis)) newest.set(row.axis, row.output);
  if (newest.size === 0) return rows[0]?.output ?? null;
  const outputs: Partial<Record<ReviewAxis, AxisReview>> = {};
  for (const axis of REVIEW_AXES) {
    const output = newest.get(axis);
    if (output) outputs[axis] = output;
  }
  return combinedReview(outputs);
}
