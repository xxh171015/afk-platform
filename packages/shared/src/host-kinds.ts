// The code hosts a repo can be on. It picks the seed template the tracker doc carries (`plat tracker-doc`), the CLI the
// doc routes to, and the adapter a worker talks to the host with. A host's kind is what the workers that have
// credentials for it report (GitHub App: github.com; a GitLab PAT: its host).
export const HOST_KINDS = ["github", "gitlab"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export const HOST_KIND_LABELS: Record<HostKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

// The repos of a project are all on one kind of host. When they are not, what to tell the person; null when they are.
export function mixedHostsProblem(
  repos: readonly { name: string; hostKind: HostKind }[],
): string | null {
  if (new Set(repos.map((r) => r.hostKind)).size <= 1) return null;
  const where = repos
    .map((r) => `${r.name} 在 ${HOST_KIND_LABELS[r.hostKind]}`)
    .join("，");
  return `一个项目的仓库要在同一种托管上：${where}。搬到同一种托管，或为它单独建项目。`;
}

// What a repo registered without a host kind is taken to be: GitLab when its address says so, GitHub otherwise. Also
// what the migration that added the column did to the repos that already existed.
export const hostKindOfUrl = (url: string): HostKind =>
  /gitlab/i.test(url) ? "gitlab" : "github";
