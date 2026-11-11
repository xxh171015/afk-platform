// git blame --porcelain (docs/design.md「plat context --files」): a 40-zero SHA is a
// working-tree line that is not in the repo yet. Those lines are skipped.

export const UNCOMMITTED_SHA = "0".repeat(40);

const RECORD = /^([0-9a-f]{40}) \d+ \d+/;

export function committedShasFromBlame(porcelain: string): string[] {
  const shas: string[] = [];
  const seen = new Set<string>();
  for (const line of porcelain.split("\n")) {
    const match = RECORD.exec(line);
    const sha = match?.[1];
    if (!sha || sha === UNCOMMITTED_SHA || seen.has(sha)) continue;
    seen.add(sha);
    shas.push(sha);
  }
  return shas;
}
