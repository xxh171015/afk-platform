import { exec, git, gitOrThrow } from "./exec.ts";

// Traceability trailers on every commit of a ticket's branch (docs/design.md「Git 操作规范」): Spec, Ticket, Run.
// Cursor's own Co-authored-by trailer stays; only our three count for tracing.

export interface TrailerIds {
  spec: string; // S-12
  ticket?: string; // T-123; the overall fix of a spec belongs to no ticket
  run: string; // R-456
}

const ID = {
  spec: /^S-[1-9][0-9]*$/,
  ticket: /^T-[1-9][0-9]*$/,
  run: /^R-[1-9][0-9]*$/,
};

export interface StampRequest {
  repoDir: string;
  branch: string;
  before: string; // the branch tip before this run: commits up to here are stamped already
  ids: TrailerIds;
  // Commits that came in from elsewhere, such as the integration branch merged into the ticket's branch by a
  // merge-fix, belong to someone else and keep their identity.
  exclude?: string;
}

export interface StampResult {
  rewritten: number;
  error?: string;
}

// Rewrites the ticket's new commits so each carries the trailers. Done with plumbing, commit by commit: same
// tree, same author, same message plus trailers, parents mapped to the rewritten ones. Unlike a rebase this
// keeps merge commits and the conflict resolutions in them exactly as the agent made them.
export function stampTrailers(request: StampRequest): StampResult {
  const { repoDir, branch, before, ids } = request;
  // The ids end up in a commit message: only our own id formats may pass.
  for (const key of ["spec", "ticket", "run"] as const) {
    const id = ids[key];
    if (id === undefined && key === "ticket") continue;
    if (id === undefined || !ID[key].test(id)) {
      throw new RangeError(`not a ${key} id: ${JSON.stringify(id)}`);
    }
  }
  const tip = gitOrThrow(repoDir, ["rev-parse", branch]);
  const listing = git(repoDir, [
    "rev-list",
    "--reverse",
    "--topo-order",
    tip,
    `^${before}`,
    ...(request.exclude ? [`^${request.exclude}`] : []),
  ]);
  if (listing.code !== 0) {
    return {
      rewritten: 0,
      error: `rev-list failed: ${listing.out.slice(0, 400)}`,
    };
  }
  const commits = listing.stdout.split("\n").filter(Boolean);
  if (commits.length === 0) return { rewritten: 0 };

  const mapped = new Map<string, string>();
  let rewrittenCount = 0;
  for (const commit of commits) {
    const info = gitOrThrow(repoDir, [
      "show",
      "-s",
      "--format=%an%x00%ae%x00%aI%x00%P%x00%T",
      commit,
    ]).split("\0");
    const [name, email, date, parents, tree] = info as [
      string,
      string,
      string,
      string,
      string,
    ];
    const message = git(repoDir, ["show", "-s", "--format=%B", commit]).stdout;
    const stamped = exec(
      "git",
      [
        "-C",
        repoDir,
        "interpret-trailers",
        "--if-exists",
        "addIfDifferent",
        "--trailer",
        `Spec: ${ids.spec}`,
        ...(ids.ticket ? ["--trailer", `Ticket: ${ids.ticket}`] : []),
        "--trailer",
        `Run: ${ids.run}`,
      ],
      { input: `${message.trimEnd()}\n` },
    );
    if (stamped.code !== 0)
      return {
        rewritten: 0,
        error: `interpret-trailers failed: ${stamped.out.slice(0, 400)}`,
      };
    const parentIds = parents.split(" ").filter(Boolean);
    const newParents = parentIds.map((parent) => mapped.get(parent) ?? parent);
    // Already carrying the trailers, on parents that stay as they are: nothing to rewrite, and the commit keeps
    // its identity (so stamping a branch twice changes nothing, not even a hash).
    const unchanged =
      stamped.stdout.trimEnd() === message.trimEnd() &&
      newParents.every((parent, index) => parent === parentIds[index]);
    if (unchanged) {
      mapped.set(commit, commit);
      continue;
    }
    rewrittenCount += 1;
    const parentArgs = newParents.flatMap((parent) => ["-p", parent]);
    const created = git(
      repoDir,
      ["commit-tree", tree, ...parentArgs, "-F", "-"],
      { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
      stamped.stdout,
    );
    if (created.code !== 0)
      return {
        rewritten: 0,
        error: `commit-tree failed: ${created.out.slice(0, 400)}`,
      };
    mapped.set(commit, created.stdout.trim());
  }

  if (mapped.get(tip) === tip) return { rewritten: 0 };

  // Move the branch only if nobody moved it meanwhile.
  const moved = git(repoDir, [
    "update-ref",
    `refs/heads/${branch}`,
    mapped.get(tip) as string,
    tip,
  ]);
  if (moved.code !== 0)
    return {
      rewritten: 0,
      error: `update-ref failed: ${moved.out.slice(0, 400)}`,
    };
  return { rewritten: rewrittenCount };
}
