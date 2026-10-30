ALTER TABLE "repos" RENAME COLUMN "role" TO "name";--> statement-breakpoint
ALTER TABLE "repos" RENAME CONSTRAINT "repos_project_role_unique" TO "repos_project_name_unique";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "contract_path" text;--> statement-breakpoint
UPDATE "repos" SET "contract_path" = substr("projects"."contract_path", length("repos"."name") + 2)
	FROM "projects"
	WHERE "repos"."project_id" = "projects"."id"
	AND split_part("projects"."contract_path", ':', 1) = "repos"."name";--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM "projects" p
		WHERE p."contract_path" IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM "repos" r WHERE r."project_id" = p."id" AND r."contract_path" IS NOT NULL)
	) THEN
		RAISE EXCEPTION 'a project has a contract path that names no repo of its own; fix projects.contract_path to <repo name>:<path> before migrating';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "contract_path";
