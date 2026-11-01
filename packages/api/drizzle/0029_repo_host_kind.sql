-- Which code host a repo is on. The repos that exist already are read once from their address: GitLab when it says
-- gitlab, GitHub otherwise (what `plat tracker-doc` used to guess on every run).
ALTER TABLE "repos" ADD COLUMN "host_kind" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
UPDATE "repos" SET "host_kind" = 'gitlab' WHERE "url" ~* 'gitlab';--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_host_kind_check" CHECK ("repos"."host_kind" in ('github', 'gitlab'));
