CREATE TABLE "instance" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" text NOT NULL,
	CONSTRAINT "instance_singleton_check" CHECK ("instance"."singleton"),
	CONSTRAINT "instance_id_check" CHECK ("instance"."id" ~ '^[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "branch_namespace" text;--> statement-breakpoint
INSERT INTO "instance" ("id") VALUES (substr(md5(random()::text || clock_timestamp()::text), 1, 6));
