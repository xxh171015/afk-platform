-- Notification dispatcher cursor and system-condition events (ADR 0009). Existing databases
-- start at the current max event id so a deploy is not a replay of history.
ALTER TABLE "instance" ADD COLUMN "last_notified_event_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "instance" SET "last_notified_event_id" = COALESCE((SELECT max(id) FROM events), 0);--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" in ('spec', 'planning', 'ticket', 'job', 'finalization', 'final-e2e', 'pull-request', 'pull-request-draft', 'pull-request-ci', 'pull-request-review', 'pull-request-sync', 'action', 'system'));--> statement-breakpoint
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
      CASE WHEN NEW.planning_state = 'blocked' THEN
        CASE WHEN COALESCE(jsonb_array_length(NEW.planning_conflict), 0) = 0 THEN 'job-failed' ELSE 'planning-conflict' END
      END, NULL, NULL);
  END IF;
  IF OLD.token_merged IS DISTINCT FROM NEW.token_merged AND NEW.token_merged THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, NEW.state, NEW.state, 'token-merged', NULL,
      jsonb_build_object('tokenMerged', true));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "specs_events" ON "specs";--> statement-breakpoint
CREATE TRIGGER "specs_events" AFTER INSERT OR UPDATE OF "state", "planning_state", "token_merged" ON "specs"
  FOR EACH ROW EXECUTE FUNCTION afk_spec_events();
