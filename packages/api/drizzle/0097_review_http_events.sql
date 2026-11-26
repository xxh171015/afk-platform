ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK ("type" in ('spec', 'planning', 'ticket', 'job', 'finalization', 'final-e2e', 'pull-request', 'pull-request-draft', 'pull-request-ci', 'pull-request-review', 'pull-request-sync', 'pull-request-head', 'pull-request-conflicts', 'pull-request-human-comments', 'review-revision', 'review-file-view', 'action', 'system', 'locate', 'auto-merged', 'auto-merge-failed'));--> statement-breakpoint
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
  IF OLD.head_sha IS DISTINCT FROM NEW.head_sha THEN
    PERFORM afk_record_event('pull-request-head', NEW.spec_id, NULL, NULL, NEW.repo_id, OLD.head_sha, NEW.head_sha, NULL,
      NULL, v_data);
  END IF;
  IF OLD.conflicts_with_default IS DISTINCT FROM NEW.conflicts_with_default THEN
    PERFORM afk_record_event('pull-request-conflicts', NEW.spec_id, NULL, NULL, NEW.repo_id,
      OLD.conflicts_with_default::text, NEW.conflicts_with_default::text, NULL, NULL, v_data);
  END IF;
  IF OLD.human_comments IS DISTINCT FROM NEW.human_comments THEN
    PERFORM afk_record_event('pull-request-human-comments', NEW.spec_id, NULL, NULL, NEW.repo_id,
      OLD.human_comments::text, NEW.human_comments::text, NULL, NULL, v_data);
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
CREATE OR REPLACE FUNCTION afk_review_revision_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_spec integer;
  v_repo integer;
BEGIN
  SELECT spec_id, repo_id INTO v_spec, v_repo FROM pull_requests WHERE id = NEW.pull_request_id;
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('review-revision', v_spec, NULL, NULL, v_repo, NULL, NEW.state, NULL, NULL,
      jsonb_build_object('pullRequestId', NEW.pull_request_id, 'headSha', NEW.head_sha));
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM afk_record_event('review-revision', v_spec, NULL, NULL, v_repo, OLD.state, NEW.state, NULL, NULL,
      jsonb_build_object('pullRequestId', NEW.pull_request_id, 'headSha', NEW.head_sha));
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "review_revisions_events" AFTER INSERT OR UPDATE ON "review_revisions"
  FOR EACH ROW EXECUTE FUNCTION afk_review_revision_events();--> statement-breakpoint
CREATE OR REPLACE FUNCTION afk_review_file_view_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_pull integer := COALESCE(NEW.pull_request_id, OLD.pull_request_id);
  v_spec integer;
  v_repo integer;
  v_path text := COALESCE(NEW.path, OLD.path);
BEGIN
  SELECT spec_id, repo_id INTO v_spec, v_repo FROM pull_requests WHERE id = v_pull;
  IF TG_OP = 'DELETE' THEN
    PERFORM afk_record_event('review-file-view', v_spec, NULL, NULL, v_repo, 'viewed', 'unviewed', NULL, NULL,
      jsonb_build_object('pullRequestId', v_pull, 'path', v_path));
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('review-file-view', v_spec, NULL, NULL, v_repo, NULL, 'viewed', NULL, NULL,
      jsonb_build_object('pullRequestId', v_pull, 'path', v_path));
    RETURN NULL;
  END IF;
  PERFORM afk_record_event('review-file-view', v_spec, NULL, NULL, v_repo, 'viewed', 'viewed', NULL, NULL,
    jsonb_build_object('pullRequestId', v_pull, 'path', v_path));
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "review_file_views_events" AFTER INSERT OR UPDATE OR DELETE ON "review_file_views"
  FOR EACH ROW EXECUTE FUNCTION afk_review_file_view_events();
