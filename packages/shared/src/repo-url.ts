import { type HostKind, hostKindOfUrl } from "./host-kinds.ts";

export interface RepoRef {
  owner: string;
  name: string;
}

// https://github.com/o/n(.git), git@github.com:o/n.git, ssh://git@github.com/o/n.git
export function parseRepoUrl(url: string): RepoRef {
  const match =
    /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match?.[1] || !match[2])
    throw new RangeError(`not a repository address: ${JSON.stringify(url)}`);
  return { owner: match[1], name: match[2] };
}

export function tryParseRepoUrl(url: string): RepoRef | null {
  try {
    return parseRepoUrl(url);
  } catch {
    return null;
  }
}

function originOf(cloneUrl: string): string | null {
  const trimmed = cloneUrl.trim();
  const https = /^(https?):\/\/([^/]+)\//i.exec(trimmed);
  if (https) return `https://${https[2]}`;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\//i.exec(trimmed);
  if (ssh) return `https://${ssh[1]}`;
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(trimmed);
  if (scp) return `https://${scp[1]}`;
  return null;
}

function browseRoot(
  cloneUrl: string,
): { origin: string; owner: string; name: string; kind: HostKind } | null {
  const ref = tryParseRepoUrl(cloneUrl);
  const origin = originOf(cloneUrl);
  if (!ref || !origin) return null;
  return { ...ref, origin, kind: hostKindOfUrl(cloneUrl) };
}

const encodePath = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

export function repoHtmlUrl(cloneUrl: string): string | null {
  const root = browseRoot(cloneUrl);
  return root ? `${root.origin}/${root.owner}/${root.name}` : null;
}

export function ownerHtmlUrl(cloneUrl: string): string | null {
  const root = browseRoot(cloneUrl);
  return root ? `${root.origin}/${root.owner}` : null;
}

export function commitHtmlUrl(cloneUrl: string, sha: string): string | null {
  const root = browseRoot(cloneUrl);
  if (!root || !sha) return null;
  const path = root.kind === "gitlab" ? "/-/commit/" : "/commit/";
  return `${root.origin}/${root.owner}/${root.name}${path}${encodeURIComponent(sha)}`;
}

export function treeHtmlUrl(cloneUrl: string, branch: string): string | null {
  const root = browseRoot(cloneUrl);
  if (!root || !branch) return null;
  const path = root.kind === "gitlab" ? "/-/tree/" : "/tree/";
  return `${root.origin}/${root.owner}/${root.name}${path}${encodePath(branch)}`;
}

export function repoDisplayName(cloneUrl: string): string | null {
  const ref = tryParseRepoUrl(cloneUrl);
  return ref ? `${ref.owner}/${ref.name}` : null;
}
