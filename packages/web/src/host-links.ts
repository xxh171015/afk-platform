import {
  commitHtmlUrl,
  ownerHtmlUrl,
  repoDisplayName,
  repoHtmlUrl,
  treeHtmlUrl,
} from "@afk/shared";

export type RepoRefView = {
  name: string;
  url: string;
  hostKind?: string;
};

export function repoLabel(repo: RepoRefView): {
  label: string;
  href: string | null;
} {
  return {
    label: repoDisplayName(repo.url) ?? repo.name,
    href: repoHtmlUrl(repo.url),
  };
}

export function ownerFromUrl(
  url: string | null | undefined,
): { owner: string; href: string | null } | null {
  if (!url) return null;
  const label = repoDisplayName(url);
  const owner = label?.split("/")[0];
  if (!owner) return null;
  return { owner, href: ownerHtmlUrl(url) };
}

export function ownerFromRepos(repos: RepoRefView[]): {
  owner: string;
  href: string | null;
} | null {
  for (const repo of repos) {
    const found = ownerFromUrl(repo.url);
    if (found) return found;
  }
  return null;
}

export { commitHtmlUrl, ownerHtmlUrl, repoHtmlUrl, treeHtmlUrl };
