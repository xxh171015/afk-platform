-- Unknown is not zero: a pull request nobody has counted comments on yet must not auto-merge (ADR 0011).
ALTER TABLE "pull_requests" ALTER COLUMN "human_comments" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ALTER COLUMN "human_comments" DROP DEFAULT;
