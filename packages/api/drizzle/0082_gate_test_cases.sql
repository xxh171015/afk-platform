-- JUnit case lists live in gate_test_cases by content hash; gate_results keeps the hash (docs/optimization-plan.md 8.11).
CREATE TABLE "gate_test_cases" (
	"hash" text PRIMARY KEY NOT NULL,
	"cases" jsonb NOT NULL
);
--> statement-breakpoint
INSERT INTO "gate_test_cases" ("hash", "cases")
SELECT encode(sha256(convert_to("test_cases"::text, 'UTF8')), 'hex'), "test_cases"
FROM "gate_results"
WHERE "test_cases" IS NOT NULL
ON CONFLICT ("hash") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "gate_results" ADD COLUMN "test_cases_hash" text;--> statement-breakpoint
UPDATE "gate_results"
SET "test_cases_hash" = encode(sha256(convert_to("test_cases"::text, 'UTF8')), 'hex')
WHERE "test_cases" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "gate_results" DROP COLUMN "test_cases";--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_test_cases_hash_gate_test_cases_hash_fk" FOREIGN KEY ("test_cases_hash") REFERENCES "public"."gate_test_cases"("hash") ON DELETE no action ON UPDATE no action;
