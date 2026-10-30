import type pg from "pg";

// Writes the ticket's current content as the snapshot of its current version. Called when a ticket is made and
// each time it is edited, in the same transaction as the change.
export async function snapshotTicket(
  client: pg.PoolClient,
  ticketId: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ticket_versions (ticket_id, version, title, body, acceptance_criteria, modules, allowed_protected_paths)
     SELECT id, content_version, title, body, acceptance_criteria, modules, allowed_protected_paths
     FROM tickets WHERE id = $1`,
    [ticketId],
  );
}

// Approving protected paths changes the ticket without a new version (it is a decision about the run, not an edit
// of the content), so the snapshot of the current version follows it: the snapshot stays what the ticket says.
export async function followApprovedPaths(
  client: pg.PoolClient,
  ticketId: number,
): Promise<void> {
  await client.query(
    `UPDATE ticket_versions v SET allowed_protected_paths = t.allowed_protected_paths
     FROM tickets t WHERE t.id = $1 AND v.ticket_id = t.id AND v.version = t.content_version`,
    [ticketId],
  );
}
