import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(result.stdout).toContain("git add docs/agents/issue-tracker.md");
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
      "nothing to register and the tracker doc is up to date",
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
    expect(result.stdout).toContain(
      "readiness: missing .sandcastle/Dockerfile, AGENTS.md",
    );
    expect(result.stdout).toContain("has .sandcastle/integration/compose.yaml");
    expect(result.stdout).toContain("nothing done");
    expect((await project(1)).status).toBe(404);
    expect(existsSync(join(backend.dir, "docs/agents/issue-tracker.md"))).toBe(
      false,
    );
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
      "readiness: missing .sandcastle/gates.yaml, .sandcastle/Dockerfile",
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

    expect(result.questions).toEqual(["Write the tracker doc?"]);
    expect(result.stdout).toContain(
      "tracker doc docs/agents/issue-tracker.md: updated",
    );
    expect(readFileSync(docPath, "utf8")).toBe(generated);
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
