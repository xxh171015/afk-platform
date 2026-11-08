-- When the scheduler last started a ticket of the spec; specs of one project holding as many slots take turns by it
-- (packages/api/src/scheduling/scheduler.ts). Null until the spec's first ticket starts.
ALTER TABLE "specs" ADD COLUMN "last_started_at" timestamp with time zone;
