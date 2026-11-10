-- GitLab PAT expiry as last read from the host (packages/api/src/host/code-hosts.ts). The page and a
-- one-time macOS notice fire when 30 days remain.
ALTER TABLE "code_hosts" ADD COLUMN "token_expires_at" text;
ALTER TABLE "code_hosts" ADD COLUMN "token_expiry_noticed_at" timestamp with time zone;
ALTER TABLE "code_hosts" ADD CONSTRAINT "code_hosts_token_expires_at_check" CHECK (
  "token_expires_at" IS NULL OR "token_expires_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
);
