import { git, gitOrThrow, hasRef, isAncestor } from "@afk/pipeline";
import {
  oneAtATime,
  type RemoteGitOptions,
  remoteGitOrThrow,
} from "./remote-git.ts";

// The job these calls to origin belong to, and their time limit (tests shorten it).
export type Remote = Pick<RemoteGitOptions, "signal" | "timeoutMs">;

// Local history the worker had to drop because origin moved: kept on the main clone, never pushed.
export const ORPHAN_REF_PREFIX = "refs/afk/orphan/";
// Slot rebuild writes a dead job's commits here instead of moving the ticket branch.
export const SALVAGE_REF_PREFIX = "refs/afk/salvage/";

export function orphanRefFor(branch: string, sha: string): string {
  return `${ORPHAN_REF_PREFIX}${branch}/${sha}`;
}

export function salvageRefFor(
  branch: string,
  jobId: number,
  attempt: number,
): string {
  return `${SALVAGE_REF_PREFIX}${branch}/${jobId}-${attempt}`;
}

// Undefined when origin has no such branch. Origin out of reach is an error: taking it for "no branch" would
// start a ticket over or push as if the branch were new.
export async function originSha(
  repoDir: string,
  branch: string,
  remote: Remote = {},
): Promise<string | undefined> {
  const ref = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  const sha = (
    await remoteGitOrThrow(repoDir, ["ls-remote", "origin", ref], remote)
  )
    .split("\t")[0]
    ?.trim();
  return sha || undefined;
}

export type TicketAlign = {
  // What --force-with-lease must still see on origin at push time, or "" if the branch must not exist yet.
  expectedOld: string;
  remoteTip?: string;
  orphan?: { orphanRef: string; orphanSha: string };
  salvage?: {
    adopted?: { salvageRef: string; sha: string };
    converted?: {
      salvageRef: string;
      orphanRef: string;
      orphanSha: string;
    }[];
  };
};

// Make the main clone's ticket branch follow origin, except a restart which drops it so the stage starts from
// the integration branch. Remote ahead fast-forwards; local strictly ahead is kept for this round to push;
// a diverge keeps the local tip as an orphan ref and moves the branch to origin. A salvage backup that is a
// descendant of the resulting tip is fast-forwarded onto the branch; any other backup is kept as an orphan.
export async function alignTicketBranch(
  repoDir: string,
  branch: string,
  options: { restart?: boolean } & Remote = {},
): Promise<TicketAlign> {
  const heads = `refs/heads/${branch}`;
  const { restart, ...calls } = options;
  const remote = await originSha(repoDir, branch, calls);
  if (remote) {
    await oneAtATime(repoDir, () =>
      remoteGitOrThrow(
        repoDir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${branch}:refs/afk/origin/${branch}`,
        ],
        calls,
      ),
    );
  }

  let result: TicketAlign;
  if (restart) {
    if (hasRef(repoDir, heads))
      gitOrThrow(repoDir, ["update-ref", "-d", heads]);
    result = {
      expectedOld: remote ?? "",
      ...(remote ? { remoteTip: remote } : {}),
    };
  } else {
    const local = hasRef(repoDir, heads)
      ? gitOrThrow(repoDir, ["rev-parse", heads])
      : undefined;

    if (!remote) result = { expectedOld: "" };
    else if (!local) {
      gitOrThrow(repoDir, ["update-ref", heads, remote]);
      result = { expectedOld: remote, remoteTip: remote };
    } else if (local === remote) {
      result = { expectedOld: remote, remoteTip: remote };
    } else if (isAncestor(repoDir, remote, local)) {
      result = { expectedOld: remote, remoteTip: remote };
    } else if (isAncestor(repoDir, local, remote)) {
      gitOrThrow(repoDir, ["update-ref", heads, remote]);
      result = { expectedOld: remote, remoteTip: remote };
    } else {
      const ref = orphanRefFor(branch, local);
      gitOrThrow(repoDir, ["update-ref", ref, local]);
      gitOrThrow(repoDir, ["update-ref", heads, remote]);
      result = {
        expectedOld: remote,
        remoteTip: remote,
        orphan: { orphanRef: ref, orphanSha: local },
      };
    }
  }
  return withSalvage(repoDir, branch, result, restart === true);
}

function consumeSalvageBackup(
  repoDir: string,
  branch: string,
  restart: boolean,
): NonNullable<TicketAlign["salvage"]> {
  const refs = git(repoDir, [
    "for-each-ref",
    "--format=%(refname)",
    `${SALVAGE_REF_PREFIX}${branch}/`,
  ])
    .stdout.split("\n")
    .filter(Boolean)
    .sort();
  const converted: NonNullable<
    NonNullable<TicketAlign["salvage"]>["converted"]
  > = [];
  let adopted: { salvageRef: string; sha: string } | undefined;
  const heads = `refs/heads/${branch}`;
  for (const salvageRef of refs) {
    const sha = gitOrThrow(repoDir, ["rev-parse", salvageRef]);
    const local = hasRef(repoDir, heads)
      ? gitOrThrow(repoDir, ["rev-parse", heads])
      : undefined;
    const take = !restart && (!local || isAncestor(repoDir, local, sha));
    if (take) {
      gitOrThrow(repoDir, ["update-ref", heads, sha]);
      adopted = { salvageRef, sha };
    } else {
      const orphanRef = orphanRefFor(branch, sha);
      gitOrThrow(repoDir, ["update-ref", orphanRef, sha]);
      converted.push({ salvageRef, orphanRef, orphanSha: sha });
    }
    gitOrThrow(repoDir, ["update-ref", "-d", salvageRef]);
  }
  return {
    ...(adopted ? { adopted } : {}),
    ...(converted.length > 0 ? { converted } : {}),
  };
}

function withSalvage(
  repoDir: string,
  branch: string,
  result: TicketAlign,
  restart: boolean,
): TicketAlign {
  const salvage = consumeSalvageBackup(repoDir, branch, restart);
  if (!salvage.adopted && !salvage.converted) return result;
  const fromSalvage = salvage.converted?.[0];
  const orphan =
    result.orphan ??
    (fromSalvage
      ? { orphanRef: fromSalvage.orphanRef, orphanSha: fromSalvage.orphanSha }
      : undefined);
  return {
    ...result,
    ...(orphan ? { orphan } : {}),
    salvage,
  };
}

export function deleteOrphanRefs(
  repoDir: string,
  branches: string[],
): string[] {
  const deleted: string[] = [];
  for (const branch of branches) {
    for (const prefix of [ORPHAN_REF_PREFIX, SALVAGE_REF_PREFIX]) {
      const listing = git(repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        `${prefix}${branch}/`,
      ]);
      for (const ref of listing.stdout.split("\n").filter(Boolean)) {
        gitOrThrow(repoDir, ["update-ref", "-d", ref]);
        deleted.push(ref);
      }
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
export async function handbackResumeStage(
  repoDir: string,
  ticketBranch: string,
  integrationBranch: string,
  ticketType: string,
  calls: Remote = {},
): Promise<HandbackResumeStage> {
  const remote = await originSha(repoDir, ticketBranch, calls);
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
