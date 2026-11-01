// A running stage is 偏慢 when it has already taken at least twice the mean of finished runs of the same
// stage in the same project. The range in the experience spec is 2～3×; the mark is at the lower bound.
// No finished history → not slow (docs/specs/experience-platform.md「偏慢」).

export const SLOW_STAGE_FACTOR = 2;

export function isSlowStage(
  elapsedMs: number,
  meanMs: number | null | undefined,
): boolean {
  return (
    meanMs !== null &&
    meanMs !== undefined &&
    meanMs > 0 &&
    elapsedMs >= meanMs * SLOW_STAGE_FACTOR
  );
}
