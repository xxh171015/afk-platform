CREATE TABLE "finalizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"step" text DEFAULT 'final-review' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finalizations_spec_repo_unique" UNIQUE("spec_id","repo_id"),
	CONSTRAINT "finalizations_step_check" CHECK ("finalizations"."step" in ('final-review', 'final-fix', 'final-merge')),
	CONSTRAINT "finalizations_state_check" CHECK ("finalizations"."state" in ('active', 'blocked', 'done')),
	CONSTRAINT "finalizations_blocked_reason_check" CHECK (("finalizations"."state" = 'blocked') = ("finalizations"."blocked_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "finalizations" ADD CONSTRAINT "finalizations_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finalizations" ADD CONSTRAINT "finalizations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;