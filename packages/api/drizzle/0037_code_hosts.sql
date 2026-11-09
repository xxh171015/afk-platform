-- The code hosts the workers have credentials for, as they last reported them at start (packages/api/src/host/
-- code-hosts.ts). A repo's host kind is its host's; a host no worker reported is one the platform cannot work on.
CREATE TABLE "code_hosts" (
  "host" text PRIMARY KEY,
  "kind" text NOT NULL,
  "worker_id" text NOT NULL,
  "reported_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "code_hosts_kind_check" CHECK ("kind" in ('github', 'gitlab')),
  CONSTRAINT "code_hosts_host_check" CHECK ("host" = lower("host"))
);
