-- Beijing calendar date of the last daily digest of awaiting-review specs (docs/optimization-plan.md 8.6).
ALTER TABLE "instance" ADD COLUMN "digest_sent_on" text;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_digest_sent_on_check" CHECK ("digest_sent_on" IS NULL OR "digest_sent_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
