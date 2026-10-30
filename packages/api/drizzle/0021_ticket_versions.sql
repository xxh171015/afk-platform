CREATE TABLE "ticket_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"acceptance_criteria" text[] NOT NULL,
	"modules" text[] NOT NULL,
	"allowed_protected_paths" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_versions_ticket_version_unique" UNIQUE("ticket_id","version")
);
--> statement-breakpoint
ALTER TABLE "ticket_versions" ADD CONSTRAINT "ticket_versions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "ticket_versions" ("ticket_id", "version", "title", "body", "acceptance_criteria", "modules", "allowed_protected_paths")
SELECT "id", "content_version", "title", "body", "acceptance_criteria", "modules", "allowed_protected_paths" FROM "tickets";
