ALTER TABLE "tickets" ADD COLUMN "refs" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "environment" text[] DEFAULT '{}' NOT NULL;
