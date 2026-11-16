-- Auto-merge host task outcomes (ADR 0011): written by the API when the worker reports merged or failed.
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" in ('spec', 'planning', 'ticket', 'job', 'finalization', 'final-e2e', 'pull-request', 'pull-request-draft', 'pull-request-ci', 'pull-request-review', 'pull-request-sync', 'action', 'system', 'locate', 'auto-merged', 'auto-merge-failed'));
