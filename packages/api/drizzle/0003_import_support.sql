ALTER TABLE "specs" ADD COLUMN "import_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_project_role_unique" UNIQUE("project_id","role");--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_project_slug_unique" UNIQUE("project_id","slug");