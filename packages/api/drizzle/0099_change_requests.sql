CREATE TABLE "change_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "spec_id" integer NOT NULL REFERENCES "specs"("id"),
  "number" integer NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "change_requests_spec_number_unique" UNIQUE("spec_id","number"),
  CONSTRAINT "change_requests_state_check" CHECK ("state" in ('active', 'done', 'superseded')),
  CONSTRAINT "change_requests_number_check" CHECK ("number" >= 1)
);
--> statement-breakpoint
CREATE INDEX "change_requests_spec_idx" ON "change_requests" ("spec_id");
--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finalizations" DROP CONSTRAINT "finalizations_step_check";
--> statement-breakpoint
ALTER TABLE "finalizations" ADD CONSTRAINT "finalizations_step_check" CHECK ("step" in ('final-review', 'final-fix', 'rework', 'recheck', 'final-merge', 'final-tidy', 'tidy-merge'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION afk_spec_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, NULL, NEW.state, NULL, NULL, NULL);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM afk_record_event('spec', NEW.id, NULL, NULL, NULL, OLD.state, NEW.state,
      CASE WHEN NEW.state = 'paused' THEN NEW.pause_reason
           WHEN NEW.state = 'merged' AND OLD.state IN ('reworking', 'finalizing')
             THEN NULLIF(current_setting('afk.reason', true), '')
           WHEN NEW.state = 'finalizing' AND OLD.state = 'awaiting-review'
             THEN NULLIF(current_setting('afk.reason', true), '')
      END,
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
