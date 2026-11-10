-- A refused GitLab/GitHub token (401/403) is an outside service, same as a 5xx (docs/specs/m3-platform.md「演练清单」).
CREATE OR REPLACE FUNCTION afk_failure_source(reason text, error text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN reason IS NULL OR reason = 'upstream-cancelled' THEN NULL
    WHEN reason IN ('invalid-output', 'no-commits', 'agent-gave-up', 'timeout', 'gate-failed', 'post-merge-gate-failed',
                    'integration-loop-exceeded', 'integration-unknown-side', 'final-e2e-failed', 'budget-exhausted') THEN 'agent'
    WHEN reason IN ('merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'contract-change-needed',
                    'integration-environment-failed', 'update-branch-conflict', 'update-branch-gate-failed',
                    'planning-conflict') THEN 'spec'
    WHEN reason = 'sync-error' THEN 'external'
    WHEN reason = 'job-failed' AND error IS NOT NULL AND (
         error ~* '(github|gitlab).*(answered |http |[(])(401|403|5[0-9][0-9])([^0-9]|$)'
      OR error ~* 'authentication required|not authenticated|cursor-agent login|unauthorized|invalid username or token'
      OR error ~* 'rate.?limit|too many requests|usage limit|http 429'
      OR error ~* 'enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake timeout'
      OR error ~* 'err_pnpm_meta_fetch_fail|registry\.npmjs\.org|registry\.npmmirror\.com') THEN 'external'
    ELSE 'platform'
  END
$$;
