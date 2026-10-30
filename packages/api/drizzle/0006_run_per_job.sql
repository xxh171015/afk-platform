DROP INDEX "runs_job_idx";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_unique" UNIQUE("job_id");