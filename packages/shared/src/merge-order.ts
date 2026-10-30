// The order a spec's pull requests are meant to be merged in, from its contract edges (docs/specs/m2-platform.md
// 「合并顺序」): a repo whose contract another repo uses is merged first. Repos with no such relation have no order
// between them. Relations are between repo names; the import has already refused a ring of them.

export interface MergeOrder {
  ordered: string[]; // the repos that are in some relation, each after the ones it waits for
  after: Record<string, string[]>; // for each of those: the repos that must be merged before it
  unordered: string[]; // the repos that are in no relation
}

export function mergeOrder(
  repos: readonly string[],
  relations: readonly { from: string; to: string }[],
): MergeOrder {
  const after: Record<string, string[]> = {};
  for (const { from, to } of relations) {
    if (from === to) continue;
    after[from] ??= [];
    after[to] = [...new Set([...(after[to] ?? []), from])].sort();
  }
  const related = repos.filter((repo) => repo in after);
  const ordered: string[] = [];
  const placed = new Set<string>();
  // repeatedly place the repos whose prerequisites are all placed (a ring would stop it; nothing loops)
  while (ordered.length < related.length) {
    const ready = related.filter(
      (repo) =>
        !placed.has(repo) &&
        (after[repo] as string[]).every((before) => placed.has(before)),
    );
    if (ready.length === 0) break;
    for (const repo of ready.sort()) {
      ordered.push(repo);
      placed.add(repo);
    }
  }
  return {
    ordered,
    after: Object.fromEntries(ordered.map((repo) => [repo, after[repo] ?? []])),
    unordered: repos.filter((repo) => !(repo in after)).sort(),
  };
}
