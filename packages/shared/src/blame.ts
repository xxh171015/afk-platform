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

export interface BlameLine {
  sha: string;
  boundary: boolean;
}

const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

// Final-file line number → the commit git blame names, and whether that commit is a
// range boundary (already present at the start of `mergeBase..head`).
export function blameLinesFromPorcelain(
  porcelain: string,
): Map<number, BlameLine> {
  const lines = porcelain.split("\n");
  const result = new Map<number, BlameLine>();
  const meta = new Map<string, boolean>();
  let i = 0;
  while (i < lines.length) {
    const header = HEADER.exec(lines[i] ?? "");
    if (!header) {
      i += 1;
      continue;
    }
    const sha = header[1] as string;
    const finalLine = Number(header[3]);
    i += 1;
    let boundary = meta.get(sha) ?? false;
    let sawMeta = false;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (line.startsWith("\t") || HEADER.test(line)) break;
      sawMeta = true;
      if (line === "boundary") boundary = true;
      i += 1;
    }
    if (sawMeta) meta.set(sha, boundary);
    else boundary = meta.get(sha) ?? false;
    if (lines[i]?.startsWith("\t")) i += 1;
    if (sha !== UNCOMMITTED_SHA) result.set(finalLine, { sha, boundary });
  }
  return result;
}
