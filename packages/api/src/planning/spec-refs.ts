import {
  type HostKind,
  tryParseRepoUrl,
  unknownHostProblem,
} from "@afk/shared";
import { hostKindOf, listHosts } from "../host/code-hosts.ts";
import { requestRepoAccess } from "../host/repo-access.ts";
import type { Queryable } from "../jobs/queue.ts";

export const SHA_RE = /^[0-9a-f]{40}$/i;

export interface SpecRefPin {
  repoId: number;
  sha: string | null;
}

export interface SpecRefInput {
  url: string;
  defaultBranch: string;
  sha?: string | null;
}

export type ResolveSpecRefsResult =
  | { status: "ok"; refs: SpecRefPin[]; registeredIds: number[] }
  | { status: "unknown-host"; message: string };

export function repoNameFromUrl(url: string): string {
  const parsed = tryParseRepoUrl(url);
  if (parsed) return parsed.name;
  const last = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .pop();
  return last && last.length > 0 ? last : "repo";
}

export function uniqueRepoName(url: string, taken: Set<string>): string {
  const name = repoNameFromUrl(url);
  if (!taken.has(name)) return name;
  const owner = (tryParseRepoUrl(url)?.owner ?? "ref").replaceAll("/", "-");
  const prefixed = `${owner}-${name}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}-${n}`)) n += 1;
  return `${prefixed}-${n}`;
}

export function pinSha(sha: string | null | undefined): string | null {
  if (sha === undefined || sha === null || sha === "") return null;
  return sha.toLowerCase();
}

async function findRepoByUrl(
  db: Queryable,
  projectId: number,
  url: string,
): Promise<{
  id: number;
  name: string;
  url: string;
  reference: boolean;
} | null> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    url: string;
    reference: boolean;
  }>(
    "SELECT id, name, url, reference FROM repos WHERE project_id = $1 AND url = $2",
    [projectId, url],
  );
  return rows[0] ?? null;
}

export async function resolveSpecRefs(
  db: Queryable,
  projectId: number,
  inputs: readonly SpecRefInput[],
  now: Date,
): Promise<ResolveSpecRefsResult> {
  const known = await listHosts(db);
  const existing = await db.query<{
    id: number;
    name: string;
    url: string;
  }>("SELECT id, name, url FROM repos WHERE project_id = $1 ORDER BY id", [
    projectId,
  ]);
  const taken = new Set(existing.rows.map((row) => row.name));
  const refs: SpecRefPin[] = [];
  const registeredIds: number[] = [];
  const seen = new Set<number>();

  for (const input of inputs) {
    if (await findRepoByUrl(db, projectId, input.url)) continue;
    const unknown = unknownHostProblem(
      uniqueRepoName(input.url, taken),
      input.url,
      known,
    );
    if (unknown) return { status: "unknown-host", message: unknown };
  }

  for (const input of inputs) {
    const found = await findRepoByUrl(db, projectId, input.url);
    if (found) {
      if (!seen.has(found.id)) {
        refs.push({ repoId: found.id, sha: pinSha(input.sha) });
        seen.add(found.id);
      }
      continue;
    }

    const intendedName = uniqueRepoName(input.url, taken);

    const hostKind: HostKind = await hostKindOf(db, input.url);
    const { rows } = await db.query<{ id: number; name: string }>(
      `INSERT INTO repos (project_id, url, default_branch, name, host_kind, reference)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name`,
      [projectId, input.url, input.defaultBranch, intendedName, hostKind],
    );
    const repo = rows[0];
    taken.add(repo.name);
    refs.push({ repoId: repo.id, sha: pinSha(input.sha) });
    seen.add(repo.id);
    registeredIds.push(repo.id);
    await requestRepoAccess(db, repo.id, now);
  }

  return { status: "ok", refs, registeredIds };
}
