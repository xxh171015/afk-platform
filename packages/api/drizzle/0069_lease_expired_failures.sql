-- A job whose lease ran out is now failed and counted like any failure (stages/failures.ts LEASE_EXPIRED_ERROR),
-- instead of being put back in the queue for ever. Its event keeps the reason lease-expired, read from the error.
CREATE OR REPLACE FUNCTION afk_job_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_reason text;
BEGIN
  IF NEW.type = 'host-sync' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NULL; END IF;
  -- a job failed by a person's cancel (of its spec) is no failure: it is recorded with no reason
  v_reason := CASE
    WHEN NEW.state = 'failed' AND current_setting('afk.source', true) IN ('page', 'cli') THEN NULL
    WHEN NEW.state = 'failed' AND NEW.error LIKE 'lease-expired:%' THEN 'lease-expired'
    WHEN NEW.state = 'failed' THEN 'job-failed'
    WHEN TG_OP = 'UPDATE' AND OLD.state = 'running' AND NEW.state = 'queued' THEN 'lease-expired'
  END;
  PERFORM afk_record_event('job', (NEW.payload->>'specId')::integer, (NEW.payload->>'ticketId')::integer, NEW.id,
    (NEW.payload->>'repoId')::integer, CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state, v_reason,
    NEW.error,
    jsonb_strip_nulls(jsonb_build_object('jobType', NEW.type, 'stage', NEW.payload->>'stage', 'attempt', NEW.attempt,
      'error', left(NEW.error, 2000))));
  RETURN NULL;
END
$$;
