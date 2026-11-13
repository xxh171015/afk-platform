// Of merge results that recorded whether the conflict was generated-only, the share that were.

export function generatedConflictShare(
  merges: readonly { generatedOnlyConflict?: boolean }[],
): number | undefined {
  const counted = merges.filter(
    (row) => row.generatedOnlyConflict !== undefined,
  );
  if (counted.length === 0) return undefined;
  return (
    counted.filter((row) => row.generatedOnlyConflict).length / counted.length
  );
}
