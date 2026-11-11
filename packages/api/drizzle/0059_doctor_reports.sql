-- Last `plat doctor` result per planning machine of a project, so the control tower 本机 list can show it.
CREATE TABLE "doctor_reports" (
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "machine" text NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  "items" jsonb NOT NULL,
  CONSTRAINT "doctor_reports_pkey" PRIMARY KEY ("project_id", "machine")
);
