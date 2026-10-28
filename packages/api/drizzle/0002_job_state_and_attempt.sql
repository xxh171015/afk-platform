ALTER TABLE "jobs" ALTER COLUMN "attempt" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('queued', 'running', 'done', 'failed'));