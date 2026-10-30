ALTER TABLE "finalizations" ADD COLUMN "job_floor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "job_floor" integer DEFAULT 0 NOT NULL;