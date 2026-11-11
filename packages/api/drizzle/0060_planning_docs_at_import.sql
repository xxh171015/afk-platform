-- Filenames of planning-doc changes the CLI saw at tickets import (not the file bodies). Page confirm uses this to name what it would drop.
ALTER TABLE "specs" ADD COLUMN "planning_docs_at_import" jsonb DEFAULT '{"status":"unknown"}'::jsonb NOT NULL;
