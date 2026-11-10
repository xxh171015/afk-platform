import type { HumanAction } from "@afk/shared";
import type pg from "pg";
import { currentOrigin } from "./origin.ts";

// A person's action is an event of its own, written by the action's code in its own transaction: unlike a state
// change, no trigger sees it (ADR 0008). The source is the page or the CLI; with no login in M3 the machine it
// came from stands in for who.
export async function recordAction(
  client: Pick<pg.PoolClient, "query">,
  action: HumanAction,
  on: { specId: number; ticketId?: number },
  details: Record<string, unknown> = {},
): Promise<void> {
  const data: Record<string, unknown> = { action };
  for (const [key, value] of Object.entries(details))
    if (value !== undefined && value !== null) data[key] = value;
  const host = currentOrigin()?.host;
  if (host) data.host = host;
  await client.query(
    `INSERT INTO events (spec_id, ticket_id, type, source, data)
     VALUES ($1, $2, 'action', NULLIF(current_setting('afk.source', true), ''), $3)`,
    [on.specId, on.ticketId ?? null, JSON.stringify(data)],
  );
}
