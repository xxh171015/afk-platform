import type pg from "pg";

// A system condition (disk, agent pause, token expiry) is an event of its own, written by the edge's
// code the way a person's action is (ADR 0008, ADR 0009). The edge flag only decides whether to insert.
export async function recordSystemEvent(
  client: Pick<pg.PoolClient, "query">,
  data: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO events (type, source, data)
     VALUES ('system', NULLIF(current_setting('afk.source', true), ''), $1)`,
    [JSON.stringify(data)],
  );
}
