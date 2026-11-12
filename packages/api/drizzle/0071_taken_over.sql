-- A person can take a ticket over (taken-over); the scheduler leaves it alone until they hand it back.
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_state_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_state_check" CHECK ("tickets"."state" in ('pending', 'queued', 'running', 'merging', 'done', 'blocked', 'cancelled', 'taken-over'));
