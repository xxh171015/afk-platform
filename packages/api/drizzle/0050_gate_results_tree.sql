-- A gate's result depends on the tree it ran on and the gates.yaml it ran by, not on the commit: the worker
-- reuses a stored pass for the same pair (docs/design.md「门禁」). Older rows have neither and are never reused.
ALTER TABLE "gate_results" ADD COLUMN "tree_sha" text;--> statement-breakpoint
ALTER TABLE "gate_results" ADD COLUMN "config_blob" text;--> statement-breakpoint
CREATE INDEX "gate_results_tree_idx" ON "gate_results" ("repo_id", "tree_sha", "config_blob");
