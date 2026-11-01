-- A spec may record the planning commit (SHA + planning repo) that its planning-repo
-- integration branch starts from. Both columns are set together, or both stay null.
ALTER TABLE "specs" ADD COLUMN "planning_sha" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "planning_repo_id" integer;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_planning_repo_id_repos_id_fk" FOREIGN KEY ("planning_repo_id") REFERENCES "public"."repos"("id");--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_planning_commit_check" CHECK (("specs"."planning_sha" is null) = ("specs"."planning_repo_id" is null));--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_planning_sha_check" CHECK ("specs"."planning_sha" is null or "specs"."planning_sha" ~ '^[0-9a-f]{40}$');
