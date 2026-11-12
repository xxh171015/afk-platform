-- A commit can have a ticket Link (from the integration merge) and a pr Link
-- (from the first look at a merged pull request) at the same SHA.
ALTER TABLE "links" DROP CONSTRAINT "links_repo_sha_unique";
ALTER TABLE "links" ADD CONSTRAINT "links_repo_sha_kind_unique" UNIQUE("repo_id","commit_sha","kind");
