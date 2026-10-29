CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"head_sha" text NOT NULL,
	"ci" text DEFAULT 'none' NOT NULL,
	"review" text DEFAULT 'none' NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_spec_repo_unique" UNIQUE("spec_id","repo_id"),
	CONSTRAINT "pull_requests_state_check" CHECK ("pull_requests"."state" in ('open', 'closed', 'merged')),
	CONSTRAINT "pull_requests_ci_check" CHECK ("pull_requests"."ci" in ('none', 'pending', 'success', 'failure')),
	CONSTRAINT "pull_requests_review_check" CHECK ("pull_requests"."review" in ('none', 'approved', 'changes-requested'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;