import { existsSync, readdirSync } from "node:fs";
import type { HostKind } from "@afk/shared";

// The code hosts this worker has credentials for, which it reports to the platform at start: github.com when the
// GitHub App's credentials are there, and each file under ~/.afk/secrets/gitlab/ (named after its host, holding a
// PAT) a GitLab host.
export function workerCodeHosts(input: {
  githubApp: boolean;
  gitlabDir: string;
}): { host: string; kind: HostKind }[] {
  const gitlab = existsSync(input.gitlabDir)
    ? readdirSync(input.gitlabDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => entry.name.toLowerCase())
        .sort()
    : [];
  return [
    ...(input.githubApp
      ? [{ host: "github.com", kind: "github" as const }]
      : []),
    ...gitlab.map((host) => ({ host, kind: "gitlab" as const })),
  ];
}
