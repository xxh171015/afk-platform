-- Review revision: diff and attribution for one pull request head (GLOSSARY Review revision).
CREATE TABLE "review_revisions" (
  "id" serial PRIMARY KEY,
  "pull_request_id" integer NOT NULL REFERENCES "pull_requests"("id"),
  "head_sha" text NOT NULL,
  "base_sha" text,
  "merge_base_sha" text,
  "previous_head_sha" text,
  "state" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "complete" boolean DEFAULT false NOT NULL,
  "omitted_reason" text,
  "files_count" integer DEFAULT 0 NOT NULL,
  "additions" integer DEFAULT 0 NOT NULL,
  "deletions" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ready_at" timestamp with time zone,
  CONSTRAINT "review_revisions_pull_head_unique" UNIQUE("pull_request_id","head_sha"),
  CONSTRAINT "review_revisions_state_check" CHECK ("state" in ('pending', 'ready', 'failed'))
);

CREATE TABLE "review_files" (
  "id" serial PRIMARY KEY,
  "revision_id" integer NOT NULL REFERENCES "review_revisions"("id"),
  "path" text NOT NULL,
  "old_path" text,
  "status" text NOT NULL,
  "old_blob" text NOT NULL,
  "new_blob" text NOT NULL,
  "additions" integer DEFAULT 0 NOT NULL,
  "deletions" integer DEFAULT 0 NOT NULL,
  "binary" boolean DEFAULT false NOT NULL,
  "generated" boolean DEFAULT false NOT NULL,
  "test" boolean DEFAULT false NOT NULL,
  "lockfile" boolean DEFAULT false NOT NULL,
  "patch" text,
  "patch_omitted" text,
  "since_patch" text,
  "attributions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "hunks" jsonb,
  CONSTRAINT "review_files_revision_path_unique" UNIQUE("revision_id","path"),
  CONSTRAINT "review_files_status_check" CHECK ("status" in ('added', 'modified', 'deleted', 'renamed', 'copied', 'mode')),
  CONSTRAINT "review_files_patch_omitted_check" CHECK ("patch_omitted" is null or "patch_omitted" in ('too-large', 'binary', 'over-total'))
);

CREATE TABLE "review_blobs" (
  "sha" text PRIMARY KEY,
  "content" text NOT NULL,
  "bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_blobs_sha_check" CHECK ("sha" ~ '^[0-9a-f]{40}$')
);

CREATE TABLE "review_file_views" (
  "pull_request_id" integer NOT NULL REFERENCES "pull_requests"("id"),
  "path" text NOT NULL,
  "new_blob" text NOT NULL,
  "viewed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "review_file_views_pkey" PRIMARY KEY ("pull_request_id", "path"),
  CONSTRAINT "review_file_views_blob_check" CHECK ("new_blob" ~ '^[0-9a-f]{40}$')
);
