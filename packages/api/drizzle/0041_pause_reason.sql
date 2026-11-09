-- Pause reasons are codes (docs/specs/m3-platform.md「暂停」). The old free-text row was the agent time running out.
UPDATE "specs" SET "pause_reason" = 'budget-exhausted'
  WHERE "state" = 'paused' AND ("pause_reason" IS NULL OR "pause_reason" NOT IN (
    'budget-exhausted', 'update-branch-conflict', 'update-branch-gate-failed'
  ));--> statement-breakpoint
UPDATE "specs" SET "pause_reason" = NULL WHERE "state" <> 'paused';--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_pause_reason_check" CHECK (
  ("state" = 'paused') = ("pause_reason" IS NOT NULL)
  AND ("pause_reason" IS NULL OR "pause_reason" IN (
    'budget-exhausted', 'update-branch-conflict', 'update-branch-gate-failed'
  ))
);
