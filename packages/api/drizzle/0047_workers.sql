-- One row per worker, last cleanup it reported (docs/specs/m3-platform.md「日志、保留与磁盘」).
CREATE TABLE "workers" (
  "id" text PRIMARY KEY,
  "reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleaned_sandbox_logs" integer DEFAULT 0 NOT NULL,
  "cleaned_salvage" integer DEFAULT 0 NOT NULL,
  "cleaned_snapshots" integer DEFAULT 0 NOT NULL
);
