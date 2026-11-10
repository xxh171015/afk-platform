-- One host-sync job per project, reused in place (packages/api/src/host/host-jobs.ts).
-- The old chain left a done row every minute; drop them and leave one queued look where a pull request is still followed.
DELETE FROM jobs WHERE type = 'host-sync';
--> statement-breakpoint
INSERT INTO jobs (type, payload, state, idempotency_key, required_capabilities)
SELECT 'host-sync',
       jsonb_build_object('projectId', p.id),
       'queued',
       'project-' || p.id || ':host-sync',
       ARRAY['host']
FROM projects p
WHERE EXISTS (
  SELECT 1 FROM pull_requests pr
  JOIN repos r ON r.id = pr.repo_id
  JOIN specs s ON s.id = pr.spec_id
  WHERE r.project_id = p.id
    AND pr.state <> 'merged'
    AND s.state NOT IN ('merged', 'cancelled')
);
