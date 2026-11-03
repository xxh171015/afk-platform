-- What the last check of the GitHub App's access to a repo found, and when a new one was asked for
-- (packages/api/src/host/repo-access.ts). Null until the repo is first checked.
ALTER TABLE "repos" ADD COLUMN "access" jsonb;
