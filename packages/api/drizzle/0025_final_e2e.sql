CREATE TABLE "final_e2e" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"blocked_reason" text,
	"round" integer DEFAULT 1 NOT NULL,
	"tickets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_floor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "final_e2e_spec_unique" UNIQUE("spec_id"),
	CONSTRAINT "final_e2e_state_check" CHECK ("final_e2e"."state" in ('active', 'blocked', 'done', 'waived')),
	CONSTRAINT "final_e2e_blocked_reason_check" CHECK (("final_e2e"."state" = 'blocked') = ("final_e2e"."blocked_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "final_e2e" ADD CONSTRAINT "final_e2e_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;
