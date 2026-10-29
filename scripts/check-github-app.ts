// Checks the GitHub App credentials against the real GitHub, without changing anything:
//   node scripts/check-github-app.ts <owner>/<repo>
// It trades the App's key for installation tokens limited to that one repository and reads the repository and its
// pull requests with them. No token is printed.
import {
  createAppTokenSource,
  defaultCredentialsDir,
  loadAppCredentials,
  parseRepoUrl,
} from "../packages/host/src/index.ts";

const target = process.argv[2];
if (!target?.includes("/")) {
  console.error("usage: node scripts/check-github-app.ts <owner>/<repo>");
  process.exit(2);
}
const repo = parseRepoUrl(`https://github.com/${target}`);

console.log(`credentials: ${defaultCredentialsDir()}`);
const tokens = createAppTokenSource({ credentials: loadAppCredentials() });

async function check(
  label: string,
  permissions: Parameters<typeof tokens.tokenFor>[0]["permissions"],
  path: string,
) {
  const token = await tokens.tokenFor({ repo, permissions });
  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    },
  );
  console.log(
    `${response.ok ? "ok  " : "FAIL"} ${label}: HTTP ${response.status}`,
  );
  if (!response.ok) process.exitCode = 1;
}

await check("read the repository (contents: read)", { contents: "read" }, "");
await check(
  "read pull requests (pull_requests: read)",
  { pull_requests: "read" },
  "/pulls?state=all&per_page=1",
);
await check(
  "read check runs (checks: read)",
  { checks: "read" },
  "/commits/HEAD/check-runs?per_page=1",
);
console.log(
  process.exitCode ? "some checks failed" : "the App works for this repository",
);
