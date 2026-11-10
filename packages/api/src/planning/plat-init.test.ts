import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { readSkillSnapshot } from "@afk/shared/skills-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";

// `plat init` against the real HTTP API and a real Postgres, in real git checkouts (test/plat-workspace.ts).

let ws: PlatWorkspace;

beforeEach(async () => {
  ws = await platWorkspace();
});
afterEach(async () => {
  await ws.close();
});

const checkout: PlatWorkspace["checkout"] = (...args) => ws.checkout(...args);
const plat: PlatWorkspace["plat"] = (...args) => ws.plat(...args);

async function project(id: number) {
  const response = await fetch(`${ws.api.url}/projects/${id}`);
  return { status: response.status, body: await response.json() };
}

const trackerDoc = (dir: string) =>
  readFileSync(join(dir, "docs/agents/issue-tracker.md"), "utf8");

describe("plat init on a code host the platform cannot work on", () => {
  const projects = async () =>
    (await (await fetch(`${ws.api.url}/projects`)).json()).projects;

  it("stops before registering anything, and says where to put the GitLab token", async () => {
    const api = checkout("api", "https://git.corp.example/team/sub/api.git");
    const result = await plat(api.dir, ["init", "--yes"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "api 在 git.corp.example，平台没有这台主机的凭据",
    );
    expect(result.stderr).toContain(
      "把 GitLab 的 PAT 放到 `~/.afk/secrets/gitlab/git.corp.example`，重启 worker 后再跑 /afk-setup",
    );
    expect(await projects()).toEqual([]);
  });

  it("stops before registering anything when the repos are on different kinds of host", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");
    const frontend = checkout(
      "frontend",
      "https://gitlab.com/acme/frontend.git",
    );
    const result = await plat(backend.dir, [
      "init",
      "--with",
      frontend.dir,
      "--yes",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("backend 在 GitHub，frontend 在 GitLab");
    expect(result.stderr).toContain("搬到同一种托管，或为它单独建项目");
    expect(await projects()).toEqual([]);
  });

  it("registers a repo on a GitLab host whose name does not say so as GitLab, nested groups and all", async () => {
    await fetch(`${ws.api.url}/worker/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "w1",
        hosts: [{ host: "git.corp.example", kind: "gitlab" }],
      }),
    });
    const api = checkout("api", "git@git.corp.example:team/sub/api.git");
    const result = await plat(api.dir, ["init", "--yes"]);
    expect(result.stderr).toBe("");
    expect((await project(1)).body.repos).toMatchObject([
      {
        name: "api",
        url: "https://git.corp.example/team/sub/api.git",
        hostKind: "gitlab",
      },
    ]);
  });
});

describe("plat init", () => {
  it("registers a new project with the planning repo and the repos given, and writes the tracker doc", async () => {
    const backend = checkout(
      "afk-pilot-backend",
      "git@github.com:acme/afk-pilot-backend.git",
      { "openapi/openapi.yaml": "openapi: 3.1.0\n", "README.md": "b\n" },
    );
    const frontend = checkout(
      "afk-pilot-frontend",
      "https://github.com/acme/afk-pilot-frontend.git",
      { "contract/openapi.yaml": "openapi: 3.1.0\n", "README.md": "f\n" },
      { defaultBranch: "trunk" },
    );

    const result = await plat(backend.dir, [
      "init",
      "--with",
      frontend.dir,
      "--yes",
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await project(1)).toEqual({
      status: 200,
      body: {
        id: 1,
        name: "afk-pilot-backend",
        defaultAgent: null,
        repos: [
          {
            name: "afk-pilot-backend",
            url: "https://github.com/acme/afk-pilot-backend.git",
            defaultBranch: "main",
            contractPath: "openapi/openapi.yaml",
            hostKind: "github",
          },
          {
            name: "afk-pilot-frontend",
            url: "https://github.com/acme/afk-pilot-frontend.git",
            defaultBranch: "trunk",
            contractPath: null,
            hostKind: "github",
          },
        ],
      },
    });
    const doc = trackerDoc(backend.dir);
    expect(doc.split("\n")[0]).toMatch(
      / project 1 repo afk-pilot-backend -->$/,
    );
    expect(doc).toContain("afk-pilot-frontend");
    expect(existsSync(join(frontend.dir, "docs/agents/issue-tracker.md"))).toBe(
      false,
    );
    expect(result.stdout).not.toContain("git add");
  });

  it("run again, finds the project through the tracker doc, keeps registered names and adds only the new repo", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git", {
      "openapi.yaml": "openapi: 3.1.0\n",
    });
    const web = checkout("web", "https://github.com/acme/web.git");
    const admin = checkout("admin", "https://github.com/acme/admin.git");
    await plat(backend.dir, ["init", "--with", `${web.dir}=frontend`, "--yes"]);

    const again = await plat(backend.dir, [
      "init",
      "--with",
      `${web.dir}=renamed`,
      "--with",
      admin.dir,
      "--yes",
    ]);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already registered as frontend");
    expect(again.stdout).toContain("registered: admin");
    expect(again.stdout).toContain(
      "tracker doc docs/agents/issue-tracker.md: updated",
    );
    const { body } = await project(1);
    expect(body.repos.map((r: { name: string }) => r.name)).toEqual([
      "backend",
      "frontend",
      "admin",
    ]);
    expect((await project(2)).status).toBe(404);

    const third = await plat(backend.dir, [
      "init",
      "--with",
      web.dir,
      "--with",
      admin.dir,
    ]);
    expect(third.code).toBe(0);
    expect(third.questions).toEqual([]);
    expect(third.stdout).toContain(
      "nothing to register and the agent docs are up to date",
    );
  });

  it("without a tracker doc, finds the project the planning repo is registered in by its address, however it is spelt", async () => {
    const backend = checkout(
      "afk-pilot-backend",
      "git@github.com:acme/afk-pilot-backend.git",
    );
    const frontend = checkout(
      "afk-pilot-frontend",
      "https://github.com/acme/afk-pilot-frontend.git",
    );
    await plat(backend.dir, ["project", "create", "shop"]);
    await plat(backend.dir, [
      "repo",
      "add",
      "--project",
      "1",
      "--name",
      "backend",
      "--url",
      "https://github.com/acme/afk-pilot-backend",
    ]);

    const result = await plat(backend.dir, [
      "init",
      "--with",
      `${frontend.dir}=frontend`,
      "--yes",
    ]);

    expect(result.code).toBe(0);
    const { body } = await project(1);
    expect(body.name).toBe("shop");
    expect(body.repos.map((r: { name: string }) => r.name)).toEqual([
      "backend",
      "frontend",
    ]);
    expect(trackerDoc(backend.dir).split("\n")[0]).toMatch(
      / project 1 repo backend -->$/,
    );
  });

  it("shows the plan with the default protected path and what each repo lacks, and on no registers and writes nothing", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git", {
      ".sandcastle/gates.yaml": "version: 1\n",
      ".sandcastle/integration/compose.yaml": "services: {}\n",
      "README.md": "b\n",
    });

    const result = await plat(backend.dir, ["init"], false);

    expect(result.code).toBe(0);
    expect(result.questions).toHaveLength(1);
    expect(result.stdout).toContain(
      "project: new, backend (protected paths: .github/**)",
    );
    expect(result.stdout).toContain("readiness: missing AGENTS.md");
    expect(result.stdout).toContain("has .sandcastle/integration/compose.yaml");
    expect(result.stdout).toContain("nothing done");
    expect((await project(1)).status).toBe(404);
    expect(existsSync(join(backend.dir, "docs/agents/issue-tracker.md"))).toBe(
      false,
    );
  });

  it("does not print GitHub-only steps for a GitLab project", async () => {
    const web = checkout("web", "https://gitlab.com/acme/web.git");

    const result = await plat(web.dir, ["init", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("GitHub App");
    expect(result.stdout).not.toContain(".github/**");
    expect(result.stdout).not.toContain("gh auth");
    expect(result.stdout).not.toContain("gh label");
    expect(result.stdout).toContain(
      "project: new, web (protected paths: .gitlab-ci.yml)",
    );
    const doc = trackerDoc(web.dir);
    const platform = doc.slice(0, doc.indexOf("## On GitLab"));
    expect(platform).not.toMatch(/pull request/i);
    expect(platform).not.toContain(".github/");
  });

  it("with --dry-run shows the plan without asking, registers and writes nothing, and succeeds", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git", {
      "AGENTS.md": "# agents\n",
    });

    const result = await plat(backend.dir, ["init", "--dry-run"], "nobody");

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.questions).toEqual([]);
    expect(result.stdout).toContain("project: new, backend");
    expect(result.stdout).toContain(
      "readiness: missing .sandcastle/gates.yaml\n",
    );
    expect(result.stdout).toContain("dry run: nothing registered or written");
    expect((await project(1)).status).toBe(404);
    expect(existsSync(join(backend.dir, "docs/agents/issue-tracker.md"))).toBe(
      false,
    );
  });

  it("does not register without a yes when nobody can answer", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");
    const result = await plat(backend.dir, ["init"], "nobody");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "plat init asks before it registers: run it in a terminal, or pass --yes",
    );
    expect((await project(1)).status).toBe(404);
  });

  it("sets the contract path only from a single openapi file or --contract-path, and reports a registered one that differs instead of changing it", async () => {
    const files = {
      "openapi/openapi.yaml": "openapi: 3.1.0\n",
      "docs/openapi-v0.json": "{}\n",
    };
    const backend = checkout(
      "backend",
      "https://github.com/acme/backend.git",
      files,
    );

    const several = await plat(backend.dir, ["init", "--yes"]);
    expect(several.stdout).toContain(
      "several openapi files (docs/openapi-v0.json, openapi/openapi.yaml), so no contract path",
    );
    expect((await project(1)).body.repos[0].contractPath).toBeNull();

    const other = checkout("other", "https://github.com/acme/other.git", files);
    await plat(other.dir, [
      "init",
      "--contract-path",
      "openapi/openapi.yaml",
      "--yes",
    ]);
    expect((await project(2)).body.repos[0].contractPath).toBe(
      "openapi/openapi.yaml",
    );

    const again = await plat(backend.dir, [
      "init",
      "--contract-path",
      "openapi/openapi.yaml",
      "--yes",
    ]);
    expect(again.stdout).toContain(
      "plat repo edit backend --project 1 --contract-path openapi/openapi.yaml",
    );
    expect((await project(1)).body.repos[0].contractPath).toBeNull();
  });

  it("takes main as the default branch, marked unconfirmed, when the remote cannot be asked", async () => {
    const backend = checkout(
      "backend",
      "https://github.com/acme/backend.git",
      { "README.md": "b\n" },
      { defaultBranch: "trunk", reachable: false },
    );

    const result = await plat(backend.dir, ["init", "--yes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("branch main (unconfirmed)");
    expect((await project(1)).body.repos[0].defaultBranch).toBe("main");
  });

  it("asks only about the tracker doc when every repo is registered and the doc is out of date", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");
    await plat(backend.dir, ["init", "--yes"]);
    const docPath = join(backend.dir, "docs/agents/issue-tracker.md");
    const generated = readFileSync(docPath, "utf8");
    writeFileSync(docPath, `${generated}\nedited by hand\n`);

    const result = await plat(backend.dir, ["init"], true);

    expect(result.questions).toEqual(["Write the agent docs?"]);
    expect(result.stdout).toContain(
      "tracker doc docs/agents/issue-tracker.md: updated",
    );
    expect(readFileSync(docPath, "utf8")).toBe(generated);
  });

  it("writes the planning files only on this machine: in the checkout, kept out of git by .git/info/exclude, AGENTS.md untouched", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git", {
      "AGENTS.md": "# agents\n",
    });

    const result = await plat(backend.dir, ["init", "--yes"]);

    expect(result.code).toBe(0);
    const read = (path: string) =>
      readFileSync(join(backend.dir, path), "utf8");
    expect(read("docs/agents/domain.md")).toBe(
      readSkillSnapshot("setup-matt-pocock-skills/domain.md"),
    );
    expect(read("docs/agents/triage-labels.md")).toBe(
      readSkillSnapshot("setup-matt-pocock-skills/triage-labels.md"),
    );
    expect(read("AGENTS.md")).toBe("# agents\n");
    const claude = read("CLAUDE.local.md");
    const cursor = read(".cursor/rules/afk-platform.mdc");
    expect(cursor.startsWith("---\n")).toBe(true);
    expect(cursor).toContain("\nalwaysApply: true\n");
    for (const rules of [claude, cursor]) {
      expect(rules).toContain("## Agent skills\n");
      expect(rules).toContain("See `docs/agents/issue-tracker.md`.");
      expect(rules).toContain("See `docs/agents/triage-labels.md`.");
      expect(rules).toContain(
        "Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.",
      );
    }
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    const exclude = read(".git/info/exclude");
    for (const path of [
      "/docs/agents/issue-tracker.md",
      "/docs/agents/domain.md",
      "/docs/agents/triage-labels.md",
      "/CLAUDE.local.md",
      "/.cursor/rules/afk-platform.mdc",
    ])
      expect(exclude.split("\n")).toContain(path);
    expect(result.stdout).toContain("CLAUDE.local.md: new");
    expect(result.stdout).toContain("docs/agents/domain.md: new");
    expect(result.stdout).toContain("on this machine only");

    const again = await plat(backend.dir, ["init"]);
    expect(again.stdout).toContain(
      "nothing to register and the agent docs are up to date",
    );
    await plat(backend.dir, ["init", "--yes"]);
    expect(read(".git/info/exclude")).toBe(exclude);
  });

  it("puts the planning conventions in the rule files: research and prototypes in a temporary worktree outside the checkout, kept on a pushed branch", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");

    await plat(backend.dir, ["init", "--yes"]);

    for (const path of ["CLAUDE.local.md", ".cursor/rules/afk-platform.mdc"]) {
      const rules = readFileSync(join(backend.dir, path), "utf8");
      expect(rules).toContain("## Planning on this machine\n");
      expect(rules).toContain(join(ws.afkHome, "planning"));
      expect(rules).toContain("`research/<name>`");
      expect(rules).toContain("`prototype/<name>`");
    }
  });

  it("puts back an exclude entry that went missing, without asking about anything else", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");
    await plat(backend.dir, ["init", "--yes"]);
    const path = join(backend.dir, ".git/info/exclude");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("/CLAUDE.local.md\n", ""),
    );

    const result = await plat(backend.dir, ["init", "--yes"]);

    expect(result.code).toBe(0);
    expect(readFileSync(path, "utf8").split("\n")).toContain(
      "/CLAUDE.local.md",
    );
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  });

  it("keeps updating the files the repo tracks: its tracker doc, its own docs/agents and the Agent skills section of CLAUDE.md", async () => {
    const claude =
      "# Shop\n\nRead this first.\n\n## Agent skills\n\nold block\n\n## Style\n\nTabs.\n";
    const backend = checkout("backend", "https://github.com/acme/backend.git", {
      "CLAUDE.md": claude,
      "AGENTS.md": "# agents\n",
      "docs/agents/domain.md": "our own domain rules\n",
      "docs/agents/issue-tracker.md": "an older tracker doc\n",
    });

    const result = await plat(backend.dir, ["init", "--yes"]);

    expect(result.code).toBe(0);
    const read = (path: string) =>
      readFileSync(join(backend.dir, path), "utf8");
    expect(read("docs/agents/domain.md")).toBe("our own domain rules\n");
    expect(read("AGENTS.md")).toBe("# agents\n");
    expect(trackerDoc(backend.dir)).toMatch(/^<!-- plat tracker-doc /);
    const edited = read("CLAUDE.md");
    expect(
      edited.startsWith("# Shop\n\nRead this first.\n\n## Agent skills\n"),
    ).toBe(true);
    expect(edited).not.toContain("old block");
    expect(edited.endsWith("## Style\n\nTabs.\n")).toBe(true);
    expect(edited.match(/## Agent skills/g)).toHaveLength(1);
    expect(read("CLAUDE.local.md")).not.toContain("## Agent skills");
    // Cursor reads AGENTS.md, not CLAUDE.md
    expect(read(".cursor/rules/afk-platform.mdc")).toContain("## Agent skills");
    expect(read("CLAUDE.local.md")).toContain("## Planning on this machine");
    const exclude = read(".git/info/exclude").split("\n");
    expect(exclude).not.toContain("/docs/agents/issue-tracker.md");
    expect(exclude).not.toContain("/docs/agents/domain.md");
    expect(exclude).toContain("/docs/agents/triage-labels.md");
    expect(
      gitOrThrow(backend.dir, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
        .split("\n")
        .map((line) => line.trim())
        .sort(),
    ).toEqual(["M CLAUDE.md", "M docs/agents/issue-tracker.md"]);
    expect(result.stdout).toContain(
      `next, in ${backend.dir}: git add docs/agents/issue-tracker.md CLAUDE.md`,
    );
  });

  it("refuses a new repo whose name the project already gives to another address", async () => {
    const backend = checkout("backend", "https://github.com/acme/backend.git");
    const web = checkout("web", "https://github.com/acme/web.git");
    const site = checkout("site", "https://github.com/other/web.git");
    await plat(backend.dir, ["init", "--with", web.dir, "--yes"]);

    const result = await plat(backend.dir, [
      "init",
      "--with",
      site.dir,
      "--yes",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `the project already has a repo named web at another address; give this one another name: --with ${site.dir}=<name>`,
    );
    expect((await project(1)).body.repos).toHaveLength(2);
  });
});
