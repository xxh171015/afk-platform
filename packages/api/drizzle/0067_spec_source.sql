-- A bug may point at another spec in the same project; feature and improvement cannot.
ALTER TABLE "specs" ADD CONSTRAINT "specs_id_project_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_source_same_project_fk" FOREIGN KEY ("source_spec_id","project_id") REFERENCES "public"."specs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_source_bug_check" CHECK ("source_spec_id" is null or "type" = 'bug');--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_source_not_self_check" CHECK ("source_spec_id" is null or "source_spec_id" <> "id");
