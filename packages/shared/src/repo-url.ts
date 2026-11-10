import { type HostKind, hostKindOfUrl } from "./host-kinds.ts";

export interface RepoRef {
  owner: string; // the namespace: one segment on GitHub, nested groups (a/b/c) on GitLab
  name: string;
  // the code host, where a worker with credentials for several picks the one the repo is on
  host?: string;
}

interface Address {
  host: string;
  path: string[]; // the namespace (one segment on GitHub, any number of nested groups on GitLab), then the repo
}

// https://host/o/n(.git), git@host:o/n.git, ssh://git@host(:port)/o/n.git; on GitLab o may be a/b/c.
function readAddress(url: string): Address | null {
  const trimmed = url.trim();
  const match =
    /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(\S+)$/i.exec(
      trimmed,
    ) ?? /^[^@/\s]+@([^:/\s]+):(\S+)$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  const path = match[2]
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (path.length < 2 || path.some((segment) => segment === "")) return null;
  return { host: match[1].toLowerCase(), path };
}

export function parseRepoUrl(url: string): RepoRef {
  const address = readAddress(url);
  if (!address)
    throw new RangeError(`not a repository address: ${JSON.stringify(url)}`);
  return {
    owner: address.path.slice(0, -1).join("/"),
    name: address.path.at(-1) as string,
  };
}

// The code host a repo is on, by its name in the address (lower case, no port); null for no repository address.
// The platform knows a host's kind from the workers that have credentials for it.
export function repoHost(url: string): string | null {
  return readAddress(url)?.host ?? null;
}

export function tryParseRepoUrl(url: string): RepoRef | null {
  try {
    return parseRepoUrl(url);
  } catch {
    return null;
  }
}

// Where the repo's pages are: the https address keeps its port, an ssh one is browsed at its host.
function originOf(cloneUrl: string): string | null {
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\//i.exec(cloneUrl.trim());
  if (https) return `https://${https[1]}`;
  const host = repoHost(cloneUrl);
  return host ? `https://${host}` : null;
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
