// Idle tickets host-sync may compare to the last platform push: not finished, not taken-over,
// a recorded last_pushed_sha, and no job in flight.

export const IDLE_TICKET_SQL = `t.state NOT IN ('done', 'cancelled', 'taken-over')
       AND t.last_pushed_sha IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.state IN ('queued', 'running')
           AND (j.payload->>'ticketId')::int = t.id
       )`;
