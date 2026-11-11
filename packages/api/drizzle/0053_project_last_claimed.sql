-- When a worker last claimed a job of this project. Claim picks the project served longest ago so
-- projects take turns (packages/api/src/jobs/queue.ts). Null until the first claim.
ALTER TABLE "projects" ADD COLUMN "last_claimed_at" timestamp with time zone;
