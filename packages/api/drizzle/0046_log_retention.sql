-- Run logs of a merged or cancelled spec are deleted after the retention period. The date is stored so
-- GET /runs/{id}/logs can say so instead of looking like a missing file. The unused log_url columns were
-- never written (docs/specs/m3-platform.md「日志、保留与磁盘」).
ALTER TABLE "runs" DROP COLUMN "log_url";
--> statement-breakpoint
ALTER TABLE "gate_results" DROP COLUMN "log_url";
--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "logs_purged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "logs_purged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "logs_purged_runs" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "logs_purged_orphans" integer DEFAULT 0 NOT NULL;
