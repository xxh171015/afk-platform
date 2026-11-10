import { type HostKind, pullAbbrev } from "@afk/shared";

export function hostKindOf(
  value: { hostKind?: string | null } | null | undefined,
): HostKind {
  return value?.hostKind === "gitlab" ? "gitlab" : "github";
}

export function hostKindOfRepos(
  repos: readonly { hostKind?: string }[] | undefined | null,
): HostKind {
  return repos?.[0]?.hostKind === "gitlab" ? "gitlab" : "github";
}

export { pullAbbrev };
