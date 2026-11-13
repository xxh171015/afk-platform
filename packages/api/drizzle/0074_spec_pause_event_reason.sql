-- Spec pause events keep the pause_reason as written (branch-moved and job-failed
-- were added in 0070; the trigger still mapped anything else to budget-exhausted).
CREATE OR REPLACE FUNCTION afk_spec_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, NULL, NEW.state, NULL, NULL, NULL);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, OLD.state, NEW.state,
      CASE WHEN NEW.state = 'paused' THEN NEW.pause_reason END,
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
$$;
