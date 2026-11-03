-- A Retry note is parked on the ticket or spec until the next Run is claimed, then copied
-- onto that Run and cleared. It is not ticket content and does not bump content_version.
ALTER TABLE "tickets" ADD COLUMN "retry_note" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "retry_note" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retry_note" text;
