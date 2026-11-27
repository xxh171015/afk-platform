-- Baseline gate: after spec confirm, one job per repo on the integration-branch cut before the first tickets.
ALTER TABLE "specs" ADD COLUMN "baseline_gate_state" text;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_baseline_gate_state_check" CHECK ("specs"."baseline_gate_state" is null or "specs"."baseline_gate_state" in ('pending', 'done', 'waived'));--> statement-breakpoint
ALTER TABLE "specs" DROP CONSTRAINT "specs_pause_reason_check";--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_pause_reason_check" CHECK (("specs"."state" = 'paused') = ("specs"."pause_reason" is not null) and ("specs"."pause_reason" is null or "specs"."pause_reason" in ('budget-exhausted', 'update-branch-conflict', 'update-branch-gate-failed', 'branch-moved', 'job-failed', 'tests-removed', 'recheck-failed', 'baseline-gate-failed')));--> statement-breakpoint
ALTER TABLE "gate_results" DROP CONSTRAINT "gate_results_kind_check";--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_kind_check" CHECK ("gate_results"."kind" in ('gate', 'e2e', 'baseline-gate'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION afk_failure_source(reason text, error text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN reason IS NULL OR reason = 'upstream-cancelled' THEN NULL
    WHEN reason IN ('invalid-output', 'no-commits', 'agent-gave-up', 'timeout', 'gate-failed', 'post-merge-gate-failed',
                    'integration-loop-exceeded', 'integration-unknown-side', 'final-e2e-failed', 'budget-exhausted') THEN 'agent'
    WHEN reason IN ('merge-conflict', 'protected-path-changed', 'contract-copy-mismatch', 'contract-change-needed',
                    'integration-environment-failed', 'update-branch-conflict', 'update-branch-gate-failed',
                    'planning-conflict', 'bug-unlocated', 'branch-moved', 'tests-removed', 'recheck-failed',
                    'baseline-gate-failed') THEN 'spec'
    WHEN reason = 'sync-error' THEN 'external'
    WHEN reason = 'sandbox-oom' THEN 'platform'
    WHEN reason = 'job-failed' AND error IS NOT NULL AND (
         error ~* '(github|gitlab).*(answered |http |[(])(401|403|5[0-9][0-9])([^0-9]|$)'
      OR error ~* 'authentication required|not authenticated|cursor-agent login|unauthorized|invalid username or token'
      OR error ~* 'rate.?limit|too many requests|usage limit|out of usage|increase limits|http 429'
      OR error ~* 'enotfound|eai_again|etimedout|econnreset|could not resolve host|tls handshake'
      OR error ~* 'failed to reach'
      OR error ~* 'err_pnpm_meta_fetch_fail|registry\.npmjs\.org|registry\.npmmirror\.com'
      OR error ~* 'invalid model|unknown model|model not found|model does not exist|no such model'
      OR error ~* 'quota[ _]?(exceeded|exhausted)|insufficient (quota|credits)|resource.?exhausted'
      OR error ~* 'docker build of .+ failed'
      OR error ~* 'gate setup failed \(exit 124\)'
      OR error ~* 'premature close'
      OR error ~* 'socket disconnected'
      OR error ~* 'secure tls connection'
      OR error ~* 'resume attempts made no progress'
      OR error ~* 'unable to access .https?://'
      OR error ~* 'ssl'
      OR error ~* 'connection timed out|connection refused'
      OR error = 'Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试'
      OR error = '模型名无效，检查项目的默认模型或 AFK_MODEL'
      OR error = 'Cursor 额度用完，充值或换模型后再试'
      OR error = '联调镜像构建失败，修好 Dockerfile 或基础镜像后再试') THEN 'external'
    ELSE 'platform'
  END
$$;
