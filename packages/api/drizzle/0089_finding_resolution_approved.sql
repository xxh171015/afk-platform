ALTER TABLE "findings" DROP CONSTRAINT "findings_resolution_check";--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolution_check" CHECK ("findings"."resolution" in ('unhandled', 'fixed', 'acceptance-pack', 'refactored', 'approved'));
