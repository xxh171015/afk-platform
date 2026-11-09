import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workerCodeHosts } from "./code-hosts.ts";

// What a worker tells the platform at start: the code hosts it has credentials for.

describe("the code hosts a worker has credentials for", () => {
  const secrets = () => mkdtempSync(join(tmpdir(), "afk-secrets-"));

  it("are github.com for the GitHub App, and one GitLab host for each file under secrets/gitlab", () => {
    const root = secrets();
    mkdirSync(join(root, "gitlab"));
    writeFileSync(join(root, "gitlab", "git.corp.example"), "glpat-x\n");
    writeFileSync(join(root, "gitlab", "GitLab.Other.Example"), "glpat-y\n");
    writeFileSync(join(root, "gitlab", ".DS_Store"), "");
    expect(
      workerCodeHosts({
        githubApp: true,
        gitlabDir: join(root, "gitlab"),
      }),
    ).toEqual([
      { host: "github.com", kind: "github" },
      { host: "git.corp.example", kind: "gitlab" },
      { host: "gitlab.other.example", kind: "gitlab" },
    ]);
  });

  it("are none without a GitHub App or a GitLab folder", () => {
    expect(
      workerCodeHosts({
        githubApp: false,
        gitlabDir: join(secrets(), "gitlab"),
      }),
    ).toEqual([]);
  });
});
