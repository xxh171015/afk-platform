ALTER TABLE "tickets" ADD COLUMN "integration_rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "resume_stage" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "fix_for_ticket_id" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "fix_round" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_fix_for_ticket_id_tickets_id_fk" FOREIGN KEY ("fix_for_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_fix_round_unique" ON "tickets" USING btree ("fix_for_ticket_id","fix_round") WHERE "tickets"."fix_for_ticket_id" is not null;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resume_stage_check" CHECK ("tickets"."resume_stage" is null or "tickets"."resume_stage" = 'e2e');--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_blocked_reason_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_blocked_reason_check" CHECK (("tickets"."state" = 'blocked') = ("tickets"."blocked_reason" is not null) and ("tickets"."blocked_reason" is null or "tickets"."blocked_reason" in ('gate-failed', 'post-merge-gate-failed', 'merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'no-commits', 'agent-gave-up', 'contract-change-needed', 'invalid-output', 'timeout', 'integration-loop-exceeded', 'integration-unknown-side', 'integration-environment-failed', 'upstream-cancelled', 'job-failed')));
