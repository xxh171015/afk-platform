-- Remaining-space alerts and the workbench status area (docs/specs/m3-platform.md「日志、保留与磁盘」).
ALTER TABLE "instance" ADD COLUMN "log_dir_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "log_dir_free_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "disk_noticed" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_disk_noticed_check" CHECK ("disk_noticed" in ('none', 'warn', 'stop'));--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "free_bytes" bigint;
