import {
  formatDisplayId,
  type PlanningDocsAtImport,
  parseDisplayId,
  sameRepoUrl,
} from "@afk/shared";
import type pg from "pg";

// Pointers from blamed commits back to specs, tickets, pull requests, and planning
// headings/ADR paths. The spec body is read to find those pointers and is never returned
// (docs/design.md「上下文沉淀与缺陷回流」, ADR 0003).

export interface ContextCommit {
  sha: string;
  spec?: string;
  ticket?: string;
  run?: string;
}

export interface ContextFileInput {
  path: string;
  commits: ContextCommit[];
}

export interface ContextFile {
  path: string;
  specs: { id: number; displayId: string }[];
  tickets: { id: number; displayId: string }[];
  pullRequests: { number: number; url: string }[];
  decisions: { specDisplayId: string; heading: string }[];
  outOfScope: { specDisplayId: string; heading: string }[];
  adrs: { path: string }[];
}

export type ContextResult =
  | { status: "ok"; files: ContextFile[] }
  | { status: "bad-request"; error: string }
  | { status: "no-repo"; error: string }
  | { status: "ambiguous"; error: string };

interface RepoRow {
  id: number;
  name: string;
  project_id: number;
  url: string;
}

const ADR_PATH = /docs\/adr\/[A-Za-z0-9][A-Za-z0-9._/-]*/g;
const DECISIONS_HEADING = "Implementation Decisions";
const SCOPE_HEADING = "Out of Scope";

function hasHeading(body: string, heading: string): boolean {
  return new RegExp(`^##\\s+${heading}\\s*$`, "m").test(body);
}

function adrPathsFrom(
  body: string,
  atImport: PlanningDocsAtImport | null,
): string[] {
  const paths = new Set<string>();
  for (const match of body.match(ADR_PATH) ?? []) {
    paths.add(match.replace(/[.,;:]+$/, ""));
  }
  if (atImport?.status === "changed") {
    for (const file of atImport.files) {
      if (file === "docs/adr" || file.startsWith("docs/adr/")) paths.add(file);
    }
  }
  return [...paths].sort();
}

async function findRepo(
  pool: Pick<pg.Pool, "query">,
  repo?: string,
  repoUrl?: string,
): Promise<
  | { status: "ok"; repo: RepoRow }
  | { status: "bad-request"; error: string }
  | { status: "no-repo"; error: string }
  | { status: "ambiguous"; error: string }
> {
  if (repo === undefined && repoUrl === undefined) {
    return {
      status: "bad-request",
      error: "give a repo name or a clone URL",
    };
  }
  const { rows } = await pool.query<RepoRow>(
    "SELECT id, name, project_id, url FROM repos ORDER BY id",
  );
  let matches = rows;
  if (repoUrl !== undefined) {
    matches = matches.filter((row) => sameRepoUrl(row.url, repoUrl));
  }
  if (repo !== undefined) {
    matches = matches.filter((row) => row.name === repo);
  }
  if (matches.length === 0) {
    return { status: "no-repo", error: "no registered repo matches" };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      error: "more than one repo matches; pass a repo name",
    };
  }
  return { status: "ok", repo: matches[0] as RepoRow };
}

async function specIdsFromTrailers(
  pool: Pick<pg.Pool, "query">,
  projectId: number,
  commits: ContextCommit[],
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const commit of commits) {
    if (!commit.spec) continue;
    const parsed = parseDisplayId(commit.spec);
    if (parsed?.kind !== "spec") continue;
    const { rowCount } = await pool.query(
      "SELECT 1 FROM specs WHERE id = $1 AND project_id = $2",
      [parsed.id, projectId],
    );
    if (rowCount) ids.add(parsed.id);
  }
  return ids;
}

async function ticketIdsFromTrailers(
  pool: Pick<pg.Pool, "query">,
  projectId: number,
  commits: ContextCommit[],
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const commit of commits) {
    if (!commit.ticket) continue;
    const parsed = parseDisplayId(commit.ticket);
    if (parsed?.kind !== "ticket") continue;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM tickets t JOIN specs s ON s.id = t.spec_id
       WHERE t.id = $1 AND s.project_id = $2`,
      [parsed.id, projectId],
    );
    if (rowCount) ids.add(parsed.id);
  }
  return ids;
}

export async function contextFor(
  pool: Pick<pg.Pool, "query">,
  input: {
    repo?: string;
    repoUrl?: string;
    files: ContextFileInput[];
  },
): Promise<ContextResult> {
  const found = await findRepo(pool, input.repo, input.repoUrl);
  if (found.status !== "ok") return found;
  const repo = found.repo;

  const shas = [
    ...new Set(
      input.files.flatMap((file) => file.commits.map((commit) => commit.sha)),
    ),
  ];
  const { rows: linkRows } = await pool.query<{
    commit_sha: string;
    spec_id: number;
    ticket_id: number | null;
  }>(
    `SELECT commit_sha, spec_id, ticket_id FROM links
     WHERE repo_id = $1 AND commit_sha = ANY($2::text[])`,
    [repo.id, shas],
  );
  const linksBySha = new Map<
    string,
    { specId: number; ticketId: number | null }[]
  >();
  for (const row of linkRows) {
    const list = linksBySha.get(row.commit_sha) ?? [];
    list.push({ specId: row.spec_id, ticketId: row.ticket_id });
    linksBySha.set(row.commit_sha, list);
  }

  const files: ContextFile[] = [];
  for (const file of input.files) {
    const specIds = new Set<number>();
    const ticketIds = new Set<number>();
    for (const commit of file.commits) {
      for (const link of linksBySha.get(commit.sha) ?? []) {
        specIds.add(link.specId);
        if (link.ticketId !== null) ticketIds.add(link.ticketId);
      }
    }
    for (const id of await specIdsFromTrailers(
      pool,
      repo.project_id,
      file.commits,
    )) {
      specIds.add(id);
    }
    for (const id of await ticketIdsFromTrailers(
      pool,
      repo.project_id,
      file.commits,
    )) {
      ticketIds.add(id);
    }

    const specList = [...specIds].sort((a, b) => a - b);
    const ticketList = [...ticketIds].sort((a, b) => a - b);

    const specs = specList.map((id) => ({
      id,
      displayId: formatDisplayId("spec", id),
    }));
    const tickets = ticketList.map((id) => ({
      id,
      displayId: formatDisplayId("ticket", id),
    }));

    const { rows: prRows } = await pool.query<{ number: number; url: string }>(
      `SELECT DISTINCT number, url FROM pull_requests
       WHERE repo_id = $1 AND spec_id = ANY($2::int[])
       ORDER BY number`,
      [repo.id, specList],
    );

    const { rows: specRows } = await pool.query<{
      id: number;
      body: string;
      planning_docs_at_import: PlanningDocsAtImport;
    }>(
      `SELECT id, body, planning_docs_at_import FROM specs
       WHERE id = ANY($1::int[]) ORDER BY id`,
      [specList],
    );

    const decisions: ContextFile["decisions"] = [];
    const outOfScope: ContextFile["outOfScope"] = [];
    const adrPaths = new Set<string>();
    for (const spec of specRows) {
      const displayId = formatDisplayId("spec", spec.id);
      if (hasHeading(spec.body, DECISIONS_HEADING)) {
        decisions.push({
          specDisplayId: displayId,
          heading: DECISIONS_HEADING,
        });
      }
      if (hasHeading(spec.body, SCOPE_HEADING)) {
        outOfScope.push({ specDisplayId: displayId, heading: SCOPE_HEADING });
      }
      for (const path of adrPathsFrom(
        spec.body,
        spec.planning_docs_at_import,
      )) {
        adrPaths.add(path);
      }
    }

    files.push({
      path: file.path,
      specs,
      tickets,
      pullRequests: prRows.map((row) => ({ number: row.number, url: row.url })),
      decisions,
      outOfScope,
      adrs: [...adrPaths].sort().map((path) => ({ path })),
    });
  }

  return { status: "ok", files };
}
