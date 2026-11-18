ALTER TABLE "finalizations" ADD COLUMN "host_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;
