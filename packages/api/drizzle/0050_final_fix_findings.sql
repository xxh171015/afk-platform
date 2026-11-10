-- Wrap-up must-fix findings stayed unhandled after final-fix finished (T-37).
-- Same meaning of `fixed` as ticket-level review-fix: the fix reported done; not a re-review.
UPDATE findings AS f
SET resolution = 'fixed'
FROM runs AS review
WHERE f.run_id = review.id
  AND f.resolution = 'unhandled'
  AND f.kind = 'must-fix'
  AND review.stage = 'final-review'
  AND review.ticket_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM runs AS fix
    WHERE fix.spec_id = review.spec_id
      AND fix.repo_id = review.repo_id
      AND fix.ticket_id IS NULL
      AND fix.stage = 'final-fix'
      AND fix.result = 'done'
  );
