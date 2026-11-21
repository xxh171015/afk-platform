ALTER TABLE "repos" ADD COLUMN "reference" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
