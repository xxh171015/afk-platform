CREATE TABLE "acceptance_packs" (
	"id" serial PRIMARY KEY NOT NULL,
	"spec_id" integer NOT NULL,
	"content" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_packs_spec_id_unique" UNIQUE("spec_id")
);
--> statement-breakpoint
ALTER TABLE "gate_results" ADD COLUMN "test_cases" jsonb;--> statement-breakpoint
ALTER TABLE "acceptance_packs" ADD CONSTRAINT "acceptance_packs_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE no action ON UPDATE no action;