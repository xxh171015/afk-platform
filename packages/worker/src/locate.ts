import { git } from "@afk/pipeline";
import { committedShasFromBlame, parseTrailers } from "@afk/shared";

// Worker half of Locate: blame the files the agent named on the named repo's
// default-branch checkout, then parse Spec/Ticket/Run trailers. The original
// spec comes from git, not from the model (GLOSSARY Locate).

export interface LocateCommit {
  sha: string;
  spec?: string;
  ticket?: string;
  run?: string;
}

export function blameLocateFiles(
  repoDir: string,
  files: string[],
  rev = "HEAD",
): LocateCommit[] {
  const commits: LocateCommit[] = [];
  const seen = new Set<string>();
  for (const path of files) {
    const blamed = git(repoDir, ["blame", "--porcelain", rev, "--", path]);
    if (blamed.code !== 0) continue;
    for (const sha of committedShasFromBlame(blamed.stdout)) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const message = git(repoDir, ["log", "-1", "--format=%B", sha]);
      const trailers = message.code === 0 ? parseTrailers(message.stdout) : {};
      commits.push({
        sha,
        ...(trailers.spec ? { spec: trailers.spec } : {}),
        ...(trailers.ticket ? { ticket: trailers.ticket } : {}),
        ...(trailers.run ? { run: trailers.run } : {}),
      });
    }
  }
  return commits;
}
