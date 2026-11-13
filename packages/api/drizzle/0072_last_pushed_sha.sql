-- The SHA of the ticket branch the platform last pushed. host-sync compares the remote tip to this;
-- tickets with no SHA are not compared. Backfill from the last agent-push Run.
ALTER TABLE "tickets" ADD COLUMN "last_pushed_sha" text;--> statement-breakpoint
UPDATE tickets t SET last_pushed_sha = (
  SELECT r.head_sha FROM runs r
  WHERE r.ticket_id = t.id AND r.head_sha IS NOT NULL
    AND r.stage IN ('implement', 'gate-fix', 'review-fix', 'merge-fix')
  ORDER BY r.id DESC LIMIT 1
);
