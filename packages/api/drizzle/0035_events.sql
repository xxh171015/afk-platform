-- Events (GLOSSARY Event): one row per state change, written by the triggers below in the same transaction as the
-- change, so a change that rolls back leaves no event. Only appended, kept for good, not backfilled
-- (docs/specs/m3-platform.md「事件表」). Who made the change comes from transaction-local settings the API sets
-- (packages/api/src/events/origin.ts): afk.source, and afk.job_id when a worker reports on a job.
CREATE TABLE "events" (
  "id" bigserial PRIMARY KEY,
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "spec_id" integer,
  "ticket_id" integer,
  "run_id" integer,
  "job_id" integer,
  "repo_id" integer,
  "type" text NOT NULL,
  "from_state" text,
  "to_state" text,
  "reason" text,
  "source" text,
  "failure_source" text,
  "data" jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT "events_type_check" CHECK ("type" in ('spec', 'planning', 'ticket', 'job', 'finalization', 'final-e2e', 'pull-request', 'pull-request-draft', 'pull-request-ci', 'pull-request-review', 'pull-request-sync')),
  CONSTRAINT "events_source_check" CHECK ("source" is null or "source" in ('scheduler', 'worker', 'host-sync', 'page', 'cli')),
  CONSTRAINT "events_failure_source_check" CHECK ("failure_source" is null or "failure_source" in ('platform', 'external', 'agent', 'spec'))
);--> statement-breakpoint
CREATE INDEX "events_spec_idx" ON "events" ("spec_id", "id");--> statement-breakpoint
CREATE INDEX "events_ticket_idx" ON "events" ("ticket_id", "id");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" ("at");--> statement-breakpoint

-- The reasons of a blocked overall review step and of a blocked final e2e were free text; they are reason codes now.
ALTER TABLE "finalizations" ADD CONSTRAINT "finalizations_blocked_reason_code_check" CHECK ("blocked_reason" is null or "blocked_reason" in ('gate-failed', 'post-merge-gate-failed', 'merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'no-commits', 'agent-gave-up', 'contract-change-needed', 'invalid-output', 'timeout', 'integration-loop-exceeded', 'integration-unknown-side', 'integration-environment-failed', 'upstream-cancelled', 'job-failed'));--> statement-breakpoint
ALTER TABLE "final_e2e" ADD CONSTRAINT "final_e2e_blocked_reason_code_check" CHECK ("blocked_reason" is null or "blocked_reason" in ('final-e2e-failed', 'integration-environment-failed'));--> statement-breakpoint

-- FAILURE_SOURCE_OF_REASON and EXTERNAL_ERROR_PATTERNS of packages/shared/src/failure-source.ts, for the triggers.
-- A test checks the two agree on every reason code; a change there needs a migration that replaces this function.
CREATE OR REPLACE FUNCTION afk_failure_source(reason text, error text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN reason IS NULL OR reason = 'upstream-cancelled' THEN NULL
    WHEN reason IN ('invalid-output', 'no-commits', 'agent-gave-up', 'timeout', 'gate-failed', 'post-merge-gate-failed',
                    'integration-loop-exceeded', 'integration-unknown-side', 'final-e2e-failed', 'budget-exhausted') THEN 'agent'
    WHEN reason IN ('merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'contract-change-needed',
                    'integration-environment-failed', 'update-branch-conflict', 'update-branch-gate-failed',
                    'planning-conflict') THEN 'spec'
    WHEN reason = 'sync-error' THEN 'external'
    WHEN reason = 'job-failed' AND error IS NOT NULL AND (
         error ~* '(github|gitlab).*(answered |http |[(])5[0-9][0-9]([^0-9]|$)'
      OR error ~* 'authentication required|not authenticated|cursor-agent login|unauthorized'
      OR error ~* 'rate.?limit|too many requests|usage limit|http 429'
      OR error ~* 'enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake timeout'
      OR error ~* 'err_pnpm_meta_fetch_fail|registry\.npmjs\.org|registry\.npmmirror\.com') THEN 'external'
    ELSE 'platform'
  END
$$;--> statement-breakpoint

-- One event. The run is the job's Run: the event's own job, or the job a worker is reporting on.
CREATE OR REPLACE FUNCTION afk_record_event(
  p_type text, p_spec integer, p_ticket integer, p_job integer, p_repo integer,
  p_from text, p_to text, p_reason text, p_error text, p_data jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_job integer := COALESCE(p_job, NULLIF(current_setting('afk.job_id', true), '')::integer);
  v_error text := p_error;
BEGIN
  -- a ticket or step blocked because its job kept failing: the source follows that job's error
  IF p_reason = 'job-failed' AND v_error IS NULL AND v_job IS NOT NULL THEN
    SELECT error INTO v_error FROM jobs WHERE id = v_job;
  END IF;
  INSERT INTO events (spec_id, ticket_id, run_id, job_id, repo_id, type, from_state, to_state, reason, source,
                      failure_source, data)
  VALUES (p_spec, p_ticket, (SELECT id FROM runs WHERE job_id = v_job ORDER BY id DESC LIMIT 1), v_job, p_repo,
          p_type, p_from, p_to, p_reason, NULLIF(current_setting('afk.source', true), ''),
          afk_failure_source(p_reason, v_error), COALESCE(p_data, '{}'));
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION afk_spec_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, NULL, NEW.state, NULL, NULL, NULL);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, OLD.state, NEW.state,
      CASE WHEN NEW.state = 'paused' THEN
        CASE WHEN NEW.pause_reason IN ('budget-exhausted', 'update-branch-conflict', 'update-branch-gate-failed')
             THEN NEW.pause_reason ELSE 'budget-exhausted' END END,
      NULL, NULL);
  END IF;
  IF OLD.planning_state IS DISTINCT FROM NEW.planning_state THEN
    PERFORM afk_record_event('planning', NEW.id, NULL, NULL, NEW.planning_repo_id, OLD.planning_state,
      NEW.planning_state,
      -- blocked with no conflicting files: its job failed three times over, which is no fault of the spec
      CASE WHEN NEW.planning_state = 'blocked' THEN
        CASE WHEN COALESCE(jsonb_array_length(NEW.planning_conflict), 0) = 0 THEN 'job-failed' ELSE 'planning-conflict' END
      END, NULL, NULL);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "specs_events" AFTER INSERT OR UPDATE OF "state", "planning_state" ON "specs"
  FOR EACH ROW EXECUTE FUNCTION afk_spec_events();--> statement-breakpoint

CREATE OR REPLACE FUNCTION afk_ticket_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state
     OR OLD.blocked_reason IS DISTINCT FROM NEW.blocked_reason THEN
    PERFORM afk_record_event('ticket', NEW.spec_id, NEW.id, NULL, NEW.repo_id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state, NEW.blocked_reason, NULL, NULL);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "tickets_events" AFTER INSERT OR UPDATE OF "state", "blocked_reason" ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION afk_ticket_events();--> statement-breakpoint

-- host-sync runs every minute and its own job says nothing: only what it finds changed is an event.
CREATE OR REPLACE FUNCTION afk_job_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_reason text;
BEGIN
  IF NEW.type = 'host-sync' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NULL; END IF;
  -- a job failed by a person's cancel (of its spec) is no failure: it is recorded with no reason
  v_reason := CASE
    WHEN NEW.state = 'failed' AND current_setting('afk.source', true) IN ('page', 'cli') THEN NULL
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
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_events" AFTER INSERT OR UPDATE OF "state" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION afk_job_events();--> statement-breakpoint

CREATE OR REPLACE FUNCTION afk_finalization_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.step IS DISTINCT FROM NEW.step THEN
    PERFORM afk_record_event('finalization', NEW.spec_id, NULL, NULL, NEW.repo_id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state, NEW.blocked_reason, NULL,
      jsonb_build_object('step', NEW.step));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "finalizations_events" AFTER INSERT OR UPDATE OF "state", "step" ON "finalizations"
  FOR EACH ROW EXECUTE FUNCTION afk_finalization_events();--> statement-breakpoint

CREATE OR REPLACE FUNCTION afk_final_e2e_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.round IS DISTINCT FROM NEW.round THEN
    PERFORM afk_record_event('final-e2e', NEW.spec_id, NULL, NULL, NULL,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END, NEW.state, NEW.blocked_reason, NULL,
      jsonb_build_object('round', NEW.round));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "final_e2e_events" AFTER INSERT OR UPDATE OF "state", "round" ON "final_e2e"
  FOR EACH ROW EXECUTE FUNCTION afk_final_e2e_events();--> statement-breakpoint

-- What host-sync (or opening one) changed about a pull request; synced_at alone is no event.
CREATE OR REPLACE FUNCTION afk_pull_request_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_data jsonb := jsonb_build_object('number', NEW.number);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('pull-request', NEW.spec_id, NULL, NULL, NEW.repo_id, NULL, NEW.state, NULL, NULL, v_data);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM afk_record_event('pull-request', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.state, NEW.state, NULL, NULL,
      v_data || jsonb_build_object('headSha', NEW.head_sha));
  END IF;
  IF OLD.draft IS DISTINCT FROM NEW.draft THEN
    PERFORM afk_record_event('pull-request-draft', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.draft::text,
      NEW.draft::text, NULL, NULL, v_data);
  END IF;
  IF OLD.ci IS DISTINCT FROM NEW.ci THEN
    PERFORM afk_record_event('pull-request-ci', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.ci, NEW.ci, NULL, NULL, v_data);
  END IF;
  IF OLD.review IS DISTINCT FROM NEW.review THEN
    PERFORM afk_record_event('pull-request-review', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.review, NEW.review, NULL,
      NULL, v_data);
  END IF;
  IF (OLD.sync_error IS NULL) <> (NEW.sync_error IS NULL) THEN
    PERFORM afk_record_event('pull-request-sync', NEW.spec_id, NULL, NULL, NEW.repo_id,
      CASE WHEN OLD.sync_error IS NULL THEN 'ok' ELSE 'error' END,
      CASE WHEN NEW.sync_error IS NULL THEN 'ok' ELSE 'error' END,
      CASE WHEN NEW.sync_error IS NOT NULL THEN 'sync-error' END, NULL,
      v_data || jsonb_strip_nulls(jsonb_build_object('error', left(NEW.sync_error, 2000))));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "pull_requests_events" AFTER INSERT OR UPDATE ON "pull_requests"
  FOR EACH ROW EXECUTE FUNCTION afk_pull_request_events();
