-- A ticket's, or a finalization's, one automatic retry of an agent stage that timed out or gave no result is spent.
-- A finalization keeps the platform's note for its own next Run: the spec's note is shared by all its repos.
ALTER TABLE "tickets" ADD COLUMN "auto_retried" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finalizations" ADD COLUMN "auto_retried" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finalizations" ADD COLUMN "retry_note" text;
