-- A retry without a note, of a ticket whose agent had finished its branch, starts again from the gate (docs/design.md
-- 「blocked 处理」): the gate is a second value of resume_stage, used once.
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_resume_stage_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resume_stage_check" CHECK ("tickets"."resume_stage" is null or "tickets"."resume_stage" in ('e2e', 'gate'));
