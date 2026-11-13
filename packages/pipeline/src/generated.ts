import { globMatches } from "./protected-paths.ts";

// Commit that must stay unchanged when the platform regenerates after a generated-only merge conflict.
export const GENERATED_UPSTREAM_ENV = "AFK_GENERATED_UPSTREAM_SHA";

export function generatedRunCommand(run: string, upstreamSha: string): string {
  const quoted = `'${upstreamSha.replaceAll("'", `'\\''`)}'`;
  return `${GENERATED_UPSTREAM_ENV}=${quoted} ${run}`;
}

// Declared generated files and the command that rebuilds them (docs/design.md「门禁」 / #294).
export interface GeneratedGroup {
  paths: string[];
  run: string;
}

function matchesGeneratedPath(file: string, pattern: string): boolean {
  return file === pattern || globMatches(pattern, file);
}

export function generatedOnlyConflicts(
  files: readonly string[],
  groups: readonly GeneratedGroup[],
): boolean {
  return (
    files.length > 0 &&
    files.every((file) =>
      groups.some((group) =>
        group.paths.some((pattern) => matchesGeneratedPath(file, pattern)),
      ),
    )
  );
}

// Groups that cover at least one of the files, in the order they were declared.
export function generatedGroupsFor(
  files: readonly string[],
  groups: readonly GeneratedGroup[],
): GeneratedGroup[] {
  return groups.filter((group) =>
    files.some((file) =>
      group.paths.some((pattern) => matchesGeneratedPath(file, pattern)),
    ),
  );
}

export function generatedCommandsNote(
  groups: readonly GeneratedGroup[],
): string {
  if (groups.length === 0) return "";
  return [
    "",
    "## Regenerating declared files",
    "These commands rebuild files the platform can regenerate; do not resolve those conflicts by hand:",
    ...groups.map((group) => `- ${group.run}  (${group.paths.join(", ")})`),
    "",
  ].join("\n");
}

export { generatedConflictShare } from "@afk/shared";
