-- A person's action (retry, cancel, edit, ...) is an event of its own type, written by the action's code
-- (packages/api/src/events/human-actions.ts).
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" in ('spec', 'planning', 'ticket', 'job', 'finalization', 'final-e2e', 'pull-request', 'pull-request-draft', 'pull-request-ci', 'pull-request-review', 'pull-request-sync', 'action'));
