-- A pause because the usage ran out tries the provider again on its own: one agent job is handed out at
-- agents_probe_at, the wait doubling after each probe (15, 30, 60 minutes, no longer than 60). A refused key leaves
-- agents_probe_at empty: only a person resumes it.
ALTER TABLE "instance" ADD COLUMN "agents_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "agents_probes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "agents_probe_job_id" integer;
