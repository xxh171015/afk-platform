-- Ticket-level review runs alongside the gate: the parallel review state (none / running / pass / fix),
-- the commit it reviewed, and the commit that already passed the gate.
ALTER TABLE "tickets" ADD COLUMN "parallel_review" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "parallel_review_sha" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "gate_passed_sha" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parallel_review_check" CHECK ("tickets"."parallel_review" in ('none', 'running', 'pass', 'fix'));
