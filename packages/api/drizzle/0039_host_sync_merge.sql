-- The host's merge time and who merged, plus a flag when the platform token did (packages/api/src/host/pull-requests.ts).
ALTER TABLE "pull_requests" ADD COLUMN "merged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "merged_by" text;
--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "token_merged" boolean DEFAULT false NOT NULL;
