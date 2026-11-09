import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostKind } from "@afk/shared";

// The PAT files under ~/.afk/secrets/gitlab/: the file name is the host, lower-cased when reported.
export function gitlabCredentialFiles(
  dir: string,
): { host: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => ({
      host: entry.name.toLowerCase(),
      path: join(dir, entry.name),
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

// The code hosts this worker has credentials for, which it reports to the platform at start: github.com when the
// GitHub App's credentials are there, and each file under ~/.afk/secrets/gitlab/ (named after its host, holding a
// PAT) a GitLab host.
export function workerCodeHosts(input: {
  githubApp: boolean;
  gitlabDir: string;
}): { host: string; kind: HostKind }[] {
  return [
    ...(input.githubApp
      ? [{ host: "github.com", kind: "github" as const }]
      : []),
    ...gitlabCredentialFiles(input.gitlabDir).map(({ host }) => ({
      host,
      kind: "gitlab" as const,
    })),
  ];
}
