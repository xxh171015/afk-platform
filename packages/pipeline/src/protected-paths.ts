import { gitOut } from "./exec.ts";

// Protected paths: configuration, CI and contracts an agent must not change unless the ticket was approved
// for it (docs/design.md「门禁」). A change counts when it touches a protected path that is not approved.

// A glob over '/'-separated paths: `**` spans directories, `*` and `?` stay within a segment, and a trailing
// '/' means everything below that directory.
export function globMatches(glob: string, path: string): boolean {
  const pattern = glob.endsWith("/") ? `${glob}**` : glob;
  return match(pattern.split("/"), path.split("/"));
}

function match(pattern: string[], path: string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    return (
      match(rest, path) || (path.length > 0 && match(pattern, path.slice(1)))
    );
  }
  const [segment, ...below] = path;
  return (
    segment !== undefined && segmentMatches(head, segment) && match(rest, below)
  );
}

function segmentMatches(pattern: string, segment: string): boolean {
  const source = [...pattern]
    .map((char) =>
      char === "*"
        ? "[^/]*"
        : char === "?"
          ? "[^/]"
          : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(segment);
}

export interface ProtectedPathCheck {
  changed: string[]; // every file the branch changed
  touched: string[]; // the protected ones among them
  unapproved: string[]; // touched and not approved: non-empty means protected-path-changed
}

export function checkProtectedPaths(input: {
  changed: readonly string[];
  protectedPaths: readonly string[];
  approved: readonly string[];
}): ProtectedPathCheck {
  const touched = input.changed.filter((file) =>
    input.protectedPaths.some((glob) => globMatches(glob, file)),
  );
  const unapproved = touched.filter(
    (file) => !input.approved.some((glob) => globMatches(glob, file)),
  );
  return { changed: [...input.changed], touched, unapproved };
}

// What `branch` changed since it left `base` (the three-dot diff: the branch's own changes only).
export function changedFiles(
  repoDir: string,
  base: string,
  branch: string,
): string[] {
  return gitOut(repoDir, ["diff", "--name-only", `${base}...${branch}`])
    .split("\n")
    .filter(Boolean);
}
