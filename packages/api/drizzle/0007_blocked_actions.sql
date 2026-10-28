ALTER TABLE "specs" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "restart" boolean DEFAULT false NOT NULL;