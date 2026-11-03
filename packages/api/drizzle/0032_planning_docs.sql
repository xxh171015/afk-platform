-- The planning repo is named when the spec is created; the platform makes the planning commit after confirm
-- (ADR 0005). So the repo can be set without a SHA, and the spec tracks where the planning commit is.
ALTER TABLE "specs" DROP CONSTRAINT "specs_planning_commit_check";--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_planning_commit_check" CHECK ("specs"."planning_sha" is null or "specs"."planning_repo_id" is not null);--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "planning_state" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "planning_patch" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "planning_conflict" jsonb;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "planning_docs_committed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_planning_state_check" CHECK ("specs"."planning_state" is null or "specs"."planning_state" in ('pending', 'done', 'blocked', 'waived'));--> statement-breakpoint
-- a spec confirmed with a planning commit the person made has it already
UPDATE "specs" SET "planning_state" = 'done' WHERE "planning_sha" IS NOT NULL;
