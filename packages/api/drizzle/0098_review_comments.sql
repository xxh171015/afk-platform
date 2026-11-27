-- Review comment: a person's note on one Review revision (GLOSSARY Review comment). Not a Finding.
CREATE TABLE "review_comments" (
  "id" serial PRIMARY KEY,
  "spec_id" integer NOT NULL REFERENCES "specs"("id"),
  "pull_request_id" integer NOT NULL REFERENCES "pull_requests"("id"),
  "revision_id" integer NOT NULL REFERENCES "review_revisions"("id"),
  "path" text,
  "side" text,
  "line_start" integer,
  "line_end" integer,
  "excerpt" text,
  "body" text NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "change_request_id" integer,
  "reply" text,
  "rework_run_id" integer REFERENCES "runs"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_comments_state_check" CHECK ("state" in ('draft', 'submitted', 'addressed', 'declined')),
  CONSTRAINT "review_comments_side_check" CHECK ("side" is null or "side" in ('old', 'new')),
  CONSTRAINT "review_comments_body_check" CHECK (char_length("body") between 1 and 4000),
  CONSTRAINT "review_comments_pr_anchor_check" CHECK ("path" is not null or ("side" is null and "line_start" is null and "line_end" is null)),
  CONSTRAINT "review_comments_line_range_check" CHECK ("line_end" is null or ("line_start" is not null and "line_end" >= "line_start"))
);

CREATE INDEX "review_comments_pull_idx" ON "review_comments" ("pull_request_id");
CREATE INDEX "review_comments_spec_state_idx" ON "review_comments" ("spec_id", "state");
