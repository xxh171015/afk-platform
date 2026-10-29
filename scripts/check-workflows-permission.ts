// Checks that the App cannot change workflow files (it has no Workflows permission), against the real GitHub:
//   node scripts/check-workflows-permission.ts <owner>/<repo>
// It makes a scratch branch from the default branch, tries to add .github/workflows/afk-probe.yml and then an
// ordinary file with a token that can write contents, and deletes the branch. The workflow file must be refused
// and the ordinary file accepted. No token is printed.
import {
  createAppTokenSource,
  loadAppCredentials,
  parseRepoUrl,
} from "../packages/host/src/index.ts";

const target = process.argv[2];
if (!target?.includes("/")) {
  console.error(
    "usage: node scripts/check-workflows-permission.ts <owner>/<repo>",
  );
  process.exit(2);
}
const repo = parseRepoUrl(`https://github.com/${target}`);
const token = await createAppTokenSource({
  credentials: loadAppCredentials(),
}).tokenFor({ repo, permissions: { contents: "write" } });

const api = (method: string, path: string, body?: unknown) =>
  fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const info = (await (await api("GET", "")).json()) as {
  default_branch: string;
};
const head = (await (
  await api("GET", `/git/ref/heads/${info.default_branch}`)
).json()) as { object: { sha: string } };
const branch = `afk-probe-${Date.now()}`;
const created = await api("POST", "/git/refs", {
  ref: `refs/heads/${branch}`,
  sha: head.object.sha,
});
console.log(`scratch branch ${branch}: HTTP ${created.status}`);
if (!created.ok) process.exit(1);

const put = (path: string) =>
  api("PUT", `/contents/${path}`, {
    message: "afk probe",
    branch,
    content: Buffer.from("probe\n").toString("base64"),
  });
try {
  const workflow = await put(".github/workflows/afk-probe.yml");
  const plain = await put("afk-probe.txt");
  console.log(
    `${workflow.ok ? "FAIL" : "ok  "} workflow file: HTTP ${workflow.status} (must be refused)`,
  );
  console.log(
    `${plain.ok ? "ok  " : "FAIL"} ordinary file: HTTP ${plain.status} (must be accepted)`,
  );
  if (workflow.ok || !plain.ok) process.exitCode = 1;
} finally {
  const gone = await api("DELETE", `/git/refs/heads/${branch}`);
  console.log(`scratch branch removed: HTTP ${gone.status}`);
}
