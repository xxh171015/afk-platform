import { git, gitOrThrow, hasRef, isAncestor } from "@afk/pipeline";

// Local history the worker had to drop because origin moved: kept on the main clone, never pushed.
export const ORPHAN_REF_PREFIX = "refs/afk/orphan/";

export function orphanRefFor(branch: string, sha: string): string {
  return `${ORPHAN_REF_PREFIX}${branch}/${sha}`;
}

export function originSha(repoDir: string, branch: string): string | undefined {
  const ref = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  const sha = git(repoDir, ["ls-remote", "origin", ref])
    .stdout.split("\t")[0]
    ?.trim();
  return sha || undefined;
}

export type TicketAlign = {
  // What --force-with-lease must still see on origin at push time, or "" if the branch must not exist yet.
  expectedOld: string;
  remoteTip?: string;
  orphan?: { orphanRef: string; orphanSha: string };
};

// Make the main clone's ticket branch follow origin, except a restart which drops it so the stage starts from
// the integration branch. Remote ahead fast-forwards; local strictly ahead is kept for this round to push;
// a diverge keeps the local tip as an orphan ref and moves the branch to origin.
export function alignTicketBranch(
  repoDir: string,
  branch: string,
  options: { restart?: boolean } = {},
): TicketAlign {
  const heads = `refs/heads/${branch}`;
  const remote = originSha(repoDir, branch);
  if (remote) {
    gitOrThrow(repoDir, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/afk/origin/${branch}`,
    ]);
  }

  if (options.restart) {
    if (hasRef(repoDir, heads))
      gitOrThrow(repoDir, ["update-ref", "-d", heads]);
    return {
      expectedOld: remote ?? "",
      ...(remote ? { remoteTip: remote } : {}),
    };
  }

  const local = hasRef(repoDir, heads)
    ? gitOrThrow(repoDir, ["rev-parse", heads])
    : undefined;

  if (!remote) return { expectedOld: "" };

  if (!local) {
    gitOrThrow(repoDir, ["update-ref", heads, remote]);
    return { expectedOld: remote, remoteTip: remote };
  }

  if (local === remote) return { expectedOld: remote, remoteTip: remote };

  if (isAncestor(repoDir, remote, local)) {
    return { expectedOld: remote, remoteTip: remote };
  }

  if (isAncestor(repoDir, local, remote)) {
    gitOrThrow(repoDir, ["update-ref", heads, remote]);
    return { expectedOld: remote, remoteTip: remote };
  }

  const ref = orphanRefFor(branch, local);
  gitOrThrow(repoDir, ["update-ref", ref, local]);
  gitOrThrow(repoDir, ["update-ref", heads, remote]);
  return {
    expectedOld: remote,
    remoteTip: remote,
    orphan: { orphanRef: ref, orphanSha: local },
  };
}

export function deleteOrphanRefs(
  repoDir: string,
  branches: string[],
): string[] {
  const deleted: string[] = [];
  for (const branch of branches) {
    const listing = git(repoDir, [
      "for-each-ref",
      "--format=%(refname)",
      `${ORPHAN_REF_PREFIX}${branch}/`,
    ]);
    for (const ref of listing.stdout.split("\n").filter(Boolean)) {
      gitOrThrow(repoDir, ["update-ref", "-d", ref]);
      deleted.push(ref);
    }
  }
  return deleted;
}

export type HandbackResumeStage = "implement" | "gate" | "e2e";

function branchTip(repoDir: string, branch: string): string {
  const ref = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  return gitOrThrow(repoDir, ["rev-parse", ref]);
}

// Where to resume after handback (docs/design.md「人接手」).
export function handbackResumeStage(
  repoDir: string,
  ticketBranch: string,
  integrationBranch: string,
  ticketType: string,
): HandbackResumeStage {
  const remote = originSha(repoDir, ticketBranch);
  if (!remote) return "implement";

  const integrationTip = branchTip(repoDir, integrationBranch);

  if (
    ticketType === "integration" &&
    isAncestor(repoDir, remote, integrationTip)
  ) {
    return "e2e";
  }

  if (!isAncestor(repoDir, integrationTip, remote)) return "gate";
  if (remote !== integrationTip) return "gate";
  return "implement";
}
