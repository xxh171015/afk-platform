import { formatDisplayId } from "@afk/shared";
import { renderTicketFile } from "@afk/shared/ticket-files";
import type pg from "pg";

// The ticket as one markdown file (ADR 0001): what the agent reads as /context/ticket.md, what `plat ticket view
// --md` prints and the ticket page shows. With `version`, the content the ticket had then (its dependencies and
// the fields that cannot be edited are the current ones). Undefined when there is no such ticket or version.
export async function ticketFileOf(
  pool: pg.Pool,
  ticketId: number,
  version?: number,
): Promise<string | undefined> {
  const found = await pool.query(
    `SELECT t.title, t.body, t.modules, t.allowed_protected_paths, t.content_version, t.type, t.refs, t.environment,
            t.stories, r.name AS repo
     FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE t.id = $1`,
    [ticketId],
  );
  let content = found.rows[0];
  if (!content) return undefined;
  const current = content.content_version as number;
  if (version !== undefined && version !== current) {
    const old = await pool.query(
      `SELECT title, body, modules, allowed_protected_paths
       FROM ticket_versions WHERE ticket_id = $1 AND version = $2`,
      [ticketId, version],
    );
    if (!old.rows[0]) return undefined;
    content = { ...content, ...old.rows[0] };
  }
  const upstream = await pool.query<{ from_ticket_id: number; kind: string }>(
    "SELECT from_ticket_id, kind FROM edges WHERE to_ticket_id = $1 ORDER BY id",
    [ticketId],
  );
  const named = (kind: string) =>
    upstream.rows
      .filter((e) => e.kind === kind)
      .map((e) => formatDisplayId("ticket", e.from_ticket_id));
  return renderTicketFile({
    id: formatDisplayId("ticket", ticketId),
    version: version ?? current,
    title: content.title,
    repo: content.repo,
    type: content.type,
    stories: content.stories,
    modules: content.modules,
    protectedPathsOk: content.allowed_protected_paths,
    contract: named("contract"),
    refs: content.refs,
    environment: content.environment,
    blockedBy: named("blocks"),
    body: content.body,
  });
}
