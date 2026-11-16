-- Wrap-up Tidy: project switch (default on), finding resolution, and the two new finalization steps.
ALTER TABLE "projects" ADD COLUMN "tidy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" DROP CONSTRAINT "findings_resolution_check";--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolution_check" CHECK ("findings"."resolution" in ('unhandled', 'fixed', 'acceptance-pack', 'refactored'));--> statement-breakpoint
ALTER TABLE "finalizations" DROP CONSTRAINT "finalizations_step_check";--> statement-breakpoint
ALTER TABLE "finalizations" ADD CONSTRAINT "finalizations_step_check" CHECK ("finalizations"."step" in ('final-review', 'final-fix', 'recheck', 'final-merge', 'final-tidy', 'tidy-merge'));
