ALTER TABLE "tickets" ADD COLUMN "fix_counts" jsonb DEFAULT '{"gate-fix":0,"review-fix":0,"merge-fix":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "reviewed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolution_check" CHECK ("findings"."resolution" in ('unhandled', 'fixed', 'acceptance-pack'));