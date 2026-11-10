ALTER TABLE "pull_requests" ADD COLUMN "platform_head_sha" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION afk_pull_request_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_data jsonb := jsonb_build_object('number', NEW.number);
  v_merge jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('pull-request', NEW.spec_id, NULL, NULL, NEW.repo_id, NULL, NEW.state, NULL, NULL, v_data);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    v_merge := v_data || jsonb_build_object('headSha', NEW.head_sha);
    IF NEW.state = 'merged' AND NEW.platform_head_sha IS NOT NULL THEN
      v_merge := v_merge || jsonb_build_object(
        'platformHead', NEW.head_sha = NEW.platform_head_sha
      );
    END IF;
    PERFORM afk_record_event('pull-request', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.state, NEW.state, NULL, NULL,
      v_merge);
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
$$;
