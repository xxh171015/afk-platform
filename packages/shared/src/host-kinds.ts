// The code hosts a repo can be on. It picks the seed template the tracker doc carries (`plat tracker-doc`) and the
// CLI the doc routes to; the platform itself only talks to GitHub so far.
export const HOST_KINDS = ["github", "gitlab"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

// What a repo registered without a host kind is taken to be: GitLab when its address says so, GitHub otherwise. Also
// what the migration that added the column did to the repos that already existed.
export const hostKindOfUrl = (url: string): HostKind =>
  /gitlab/i.test(url) ? "gitlab" : "github";
