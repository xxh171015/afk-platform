-- Link (GLOSSARY): commit SHA ↔ Ticket / Spec / PR. ticket kind is written when a ticket (or wrap-up
-- fix) merges into the integration branch, from the rewritten SHAs that run recorded. pr kind comes later.
CREATE TABLE "links" (
  "id" serial PRIMARY KEY,
  "repo_id" integer NOT NULL REFERENCES "repos"("id"),
  "commit_sha" text NOT NULL,
  "spec_id" integer NOT NULL REFERENCES "specs"("id"),
  "ticket_id" integer REFERENCES "tickets"("id"),
  "run_id" integer REFERENCES "runs"("id"),
  "pull_request_id" integer REFERENCES "pull_requests"("id"),
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "links_repo_sha_unique" UNIQUE("repo_id","commit_sha"),
  CONSTRAINT "links_kind_check" CHECK ("kind" in ('ticket', 'pr')),
  CONSTRAINT "links_sha_check" CHECK ("commit_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "links_ticket_kind_run_check" CHECK ("kind" <> 'ticket' or "run_id" is not null)
);
CREATE INDEX "links_spec_idx" ON "links" ("spec_id");
CREATE INDEX "links_sha_idx" ON "links" ("commit_sha");
