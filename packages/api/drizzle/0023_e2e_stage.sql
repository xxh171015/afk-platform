ALTER TABLE "gate_results" ADD COLUMN "kind" text DEFAULT 'gate' NOT NULL;--> statement-breakpoint
ALTER TABLE "gate_results" DROP CONSTRAINT "gate_results_repo_commit_unique";--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_repo_commit_kind_unique" UNIQUE("repo_id","commit_sha","kind");--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_kind_check" CHECK ("gate_results"."kind" in ('gate', 'e2e'));--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tests_total" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tests_failed" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "env_up_ms" integer;--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_blocked_reason_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_blocked_reason_check" CHECK (("tickets"."state" = 'blocked') = ("tickets"."blocked_reason" is not null) and ("tickets"."blocked_reason" is null or "tickets"."blocked_reason" in ('gate-failed', 'post-merge-gate-failed', 'merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'no-commits', 'agent-gave-up', 'contract-change-needed', 'invalid-output', 'timeout', 'integration-loop-exceeded', 'integration-environment-failed', 'upstream-cancelled', 'job-failed')));
