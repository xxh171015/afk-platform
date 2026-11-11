-- Final e2e unrecoverable errors (a failed image build, a dead Cursor key) block with
-- job-failed, same as a ticket-level integration job (T-50).
ALTER TABLE "final_e2e" DROP CONSTRAINT "final_e2e_blocked_reason_code_check";
ALTER TABLE "final_e2e" ADD CONSTRAINT "final_e2e_blocked_reason_code_check" CHECK ("blocked_reason" is null or "blocked_reason" in ('final-e2e-failed', 'integration-environment-failed', 'job-failed'));
