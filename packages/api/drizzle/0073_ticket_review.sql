-- Ticket-level review: spec (default, Spec axis only) or both. final-review is always both (ADR 0002).
ALTER TABLE "projects" ADD COLUMN "ticket_review" text DEFAULT 'spec' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ticket_review_check" CHECK ("projects"."ticket_review" in ('spec','both'));
