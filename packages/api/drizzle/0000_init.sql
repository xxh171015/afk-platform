CREATE TABLE "edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_ticket_id" integer NOT NULL,
	"to_ticket_id" integer NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "edges_from_to_kind_unique" UNIQUE("from_ticket_id","to_ticket_id","kind"),
	CONSTRAINT "edges_no_self_dependency" CHECK ("edges"."from_ticket_id" <> "edges"."to_ticket_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"resolution" text DEFAULT 'unhandled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"config_sha" text NOT NULL,
	"command_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tests_total" integer,
	"tests_skipped" integer,
	"log_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_results_repo_commit_unique" UNIQUE("repo_id","commit_sha")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"lock_key" text,
	"required_capabilities" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_agent" text,
	"default_model" text,
	"contract_path" text,
	"protected_paths" text[] DEFAULT '{}' NOT NULL,
	"max_concurrency" integer,
	"budget_limit" integer,
	"merge_policy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"ticket_id" integer,
	"ticket_version" integer,
	"job_id" integer,
	"stage" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"agent" text,
	"model" text,
	"skills_sha" text,
	"cursor_cli_version" text,
	"branch" text,
	"base_sha" text,
	"head_sha" text,
	"commits" text[] DEFAULT '{}' NOT NULL,
	"duration_ms" integer,
	"duration_api_ms" integer,
	"token_usage" jsonb,
	"result" text,
	"output" jsonb,
	"log_url" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"type" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"source_spec_id" integer,
	"integration_branches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"acceptance_criteria" text[] DEFAULT '{}' NOT NULL,
	"modules" text[] DEFAULT '{}' NOT NULL,
	"allowed_protected_paths" text[] DEFAULT '{}' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"blocked_reason" text,
	"content_version" integer DEFAULT 1 NOT NULL,
	"contract_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_ticket_id_tickets_id_fk" FOREIGN KEY ("from_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_ticket_id_tickets_id_fk" FOREIGN KEY ("to_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_source_spec_id_specs_id_fk" FOREIGN KEY ("source_spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;