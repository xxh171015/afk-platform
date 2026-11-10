// Checks one GitLab PAT file (~/.afk/secrets/gitlab/<host>, mode 600) against that
// host's user API, without changing anything:
//   node scripts/check-gitlab-token.ts <path>
import { statSync } from "node:fs";
import { basename } from "node:path";
import {
  createGitLabTokenSource,
  describeGitLabToken,
} from "../packages/host/src/index.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/check-gitlab-token.ts <path>");
  process.exit(2);
}

const host = basename(path).toLowerCase();
if (statSync(path).mode & 0o077) {
  console.error(`${path} must only be readable by you: chmod 600 ${path}`);
  process.exit(1);
}

function apiUrlForHost(name: string): string {
  const loopback = /^(127\.0\.0\.1|localhost)(:|$)/i.test(name);
  return `${loopback ? "http" : "https"}://${name}/api/v4`;
}

try {
  const token = await createGitLabTokenSource({ path }).tokenFor({
    repo: { owner: "-", name: "-", host },
    permissions: {},
  });
  const identity = await describeGitLabToken({
    token,
    apiUrl: apiUrlForHost(host),
  });
  const expiry =
    identity.tokenExpiresAt === undefined
      ? ""
      : identity.tokenExpiresAt === null
        ? ", no expiry"
        : `, expires ${identity.tokenExpiresAt}`;
  console.log(`GitLab token for ${host}: ${identity.username}${expiry}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`GitLab token for ${host}: ${message}`);
  process.exit(1);
}
