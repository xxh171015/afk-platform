-- After handback the worker resolves the resume stage from the remote tip on the next implement job.
ALTER TABLE "tickets" ADD COLUMN "handback_pending" boolean DEFAULT false NOT NULL;
