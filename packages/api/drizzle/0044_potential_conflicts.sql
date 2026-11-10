-- A pair of specs whose integration branches in one repo would conflict (docs/specs/m3-platform.md「trial-merge」).
-- spec_id_a < spec_id_b so each pair has one row; overwritten on the next check, deleted when there is no
-- conflict or either spec is merged or cancelled.
CREATE TABLE "potential_conflicts" (
  "id" serial PRIMARY KEY,
  "spec_id_a" integer NOT NULL REFERENCES "specs"("id"),
  "spec_id_b" integer NOT NULL REFERENCES "specs"("id"),
  "repo_id" integer NOT NULL REFERENCES "repos"("id"),
  "files" text[] NOT NULL,
  "sha_a" text NOT NULL,
  "sha_b" text NOT NULL,
  "discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "potential_conflicts_pair_unique" UNIQUE("spec_id_a","spec_id_b","repo_id"),
  CONSTRAINT "potential_conflicts_ordered_check" CHECK ("spec_id_a" < "spec_id_b"),
  CONSTRAINT "potential_conflicts_files_check" CHECK (cardinality("files") > 0)
);
CREATE INDEX "potential_conflicts_spec_a_idx" ON "potential_conflicts" ("spec_id_a");
CREATE INDEX "potential_conflicts_spec_b_idx" ON "potential_conflicts" ("spec_id_b");
