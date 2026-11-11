-- The agent's provider refusing all work (its quota spent, the key refused) pauses every agent job until a person
-- resumes them (docs/design.md「作业与恢复」). Cursor's "out of usage" and a broken TLS handshake are outside services.
ALTER TABLE "instance" ADD COLUMN "agents_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "agents_pause_reason" text;--> statement-breakpoint
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
      OR error ~* 'rate.?limit|too many requests|usage limit|out of usage|increase limits|http 429'
      OR error ~* 'enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake'
      OR error ~* 'err_pnpm_meta_fetch_fail|registry\.npmjs\.org|registry\.npmmirror\.com'
      OR error ~* 'invalid model|unknown model|model not found|model does not exist|no such model'
      OR error ~* 'quota[ _]?(exceeded|exhausted)|insufficient (quota|credits)|resource.?exhausted'
      OR error ~* 'docker build of .+ failed'
      OR error = 'Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试'
      OR error = '模型名无效，检查项目的默认模型或 AFK_MODEL'
      OR error = 'Cursor 额度用完，充值或换模型后再试'
      OR error = '联调镜像构建失败，修好 Dockerfile 或基础镜像后再试') THEN 'external'
    ELSE 'platform'
  END
$$;
