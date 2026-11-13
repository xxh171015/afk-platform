-- Per-role model overrides for Standards, update-branch, and merge-fix. Other keys are rejected at the HTTP layer.
ALTER TABLE "projects" ADD COLUMN "stage_models" jsonb DEFAULT '{}'::jsonb NOT NULL;
