import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { bundleFor, makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cutIntegrationBranch, fetchDomain } from "./domain.ts";
import { pushRef } from "./push.ts";
import { RepoStore } from "./repos.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function origin(files: Record<string, string>): TestRepo {
  const repo = makeRepo(files);
  cleanups.push(() => repo.cleanup());
  return repo;
}

function store(): RepoStore {
  const root = mkdtempSync(join(tmpdir(), "afk-worker-domain-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new RepoStore(root);
}

// What afk-setup pushes: an afk/setup branch on origin, the default branch left as it was.
function pushSetup(repo: TestRepo, files: Record<string, string>): string {
  gitOrThrow(repo.dir, ["checkout", "--quiet", "-b", "afk/setup"]);
  const sha = repo.commit(files, "Set up for the AFK platform");
  gitOrThrow(repo.dir, ["checkout", "--quiet", "main"]);
  return sha;
}

const SHA = {
  repo: "backend",
  url: "",
  defaultBranch: "main",
};

describe("fetchDomain", () => {
  it("reads GLOSSARY and ADRs at the planning SHA and omits AGENTS.md", () => {
    const planning = origin({
      "GLOSSARY.md": "# v1\n",
      "AGENTS.md": "secret\n",
      "docs/adr/0001.md": "# adr\n",
      "src/app.ts": "code\n",
    });
    const sha = planning.commit(
      {
        "GLOSSARY.md": "# v2\n",
        "AGENTS.md": "still secret\n",
        "docs/adr/0001.md": "# adr2\n",
      },
      "planning",
    );
    planning.commit({ "GLOSSARY.md": "# v3\n" }, "later");
    expect(
      fetchDomain(store(), { ...SHA, url: planning.dir, sha }, "frontend"),
    ).toEqual([
      { path: "GLOSSARY.md", content: "# v2\n" },
      { path: "docs/adr/0001.md", content: "# adr2\n" },
    ]);
  });

  it("does not mount domain files for the planning repo's own tickets", () => {
    const planning = origin({ "GLOSSARY.md": "# t\n" });
    const sha = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    expect(
      fetchDomain(store(), { ...SHA, url: planning.dir, sha }, "backend"),
    ).toBeUndefined();
  });

  it("gives nothing when confirm stored no planning commit", () => {
    expect(fetchDomain(store(), null, "frontend")).toBeUndefined();
  });
});

describe("cutIntegrationBranch", () => {
  it("starts the planning repo's integration branch at the planning SHA, not at main", () => {
    const planning = origin({ "GLOSSARY.md": "# v1\n" });
    const initial = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    const sha = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning");
    gitOrThrow(planning.dir, ["update-ref", "refs/heads/plan/s", sha]);
    gitOrThrow(planning.dir, ["update-ref", "refs/heads/main", initial]);

    const repos = store();
    const mainDir = repos.ensure("backend", planning.dir, "main");
    const bundle = bundleFor({
      repo: {
        id: 1,
        name: "backend",
        url: planning.dir,
        defaultBranch: "main",
      },
      integrationBranch: "spec/1/order-export",
      domain: {
        repo: "backend",
        url: planning.dir,
        defaultBranch: "main",
        sha,
      },
    });
    cutIntegrationBranch(repos, (request) => pushRef(request), mainDir, bundle);
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(sha);
    expect(gitOrThrow(planning.dir, ["rev-parse", "spec/1/order-export"])).toBe(
      sha,
    );
    expect(sha).not.toBe(initial);
  });

  it("starts another repo's integration branch at its default branch", () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    const head = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = repos.ensure("frontend", frontend.dir, "main");
    const bundle = bundleFor({
      repo: {
        id: 2,
        name: "frontend",
        url: frontend.dir,
        defaultBranch: "main",
      },
      integrationBranch: "spec/1/order-export",
      domain: {
        repo: "backend",
        url: "git@x:backend",
        defaultBranch: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    cutIntegrationBranch(repos, (request) => pushRef(request), mainDir, bundle);
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      head,
    );
  });

  it("starts at master when that is the repo's default branch", () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    gitOrThrow(frontend.dir, ["branch", "-m", "main", "master"]);
    const head = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = repos.ensure("frontend", frontend.dir, "master");
    const bundle = bundleFor({
      repo: {
        id: 2,
        name: "frontend",
        url: frontend.dir,
        defaultBranch: "master",
      },
      integrationBranch: "spec/1/order-export",
      domain: {
        repo: "backend",
        url: "git@x:backend",
        defaultBranch: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    cutIntegrationBranch(repos, (request) => pushRef(request), mainDir, bundle);
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      head,
    );
  });

  it("leaves an integration branch that already exists", () => {
    const planning = origin({ "GLOSSARY.md": "# v1\n" });
    const first = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    const later = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning");
    const repos = store();
    const mainDir = repos.ensure("backend", planning.dir, "main");
    gitOrThrow(mainDir, [
      "update-ref",
      "refs/heads/spec/1/order-export",
      first,
    ]);
    const bundle = bundleFor({
      repo: {
        id: 1,
        name: "backend",
        url: planning.dir,
        defaultBranch: "main",
      },
      integrationBranch: "spec/1/order-export",
      domain: {
        repo: "backend",
        url: planning.dir,
        defaultBranch: "main",
        sha: later,
      },
    });
    cutIntegrationBranch(repos, (request) => pushRef(request), mainDir, bundle);
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      first,
    );
  });

  describe("with an afk/setup branch on origin", () => {
    const cut = (repo: TestRepo) => {
      const repos = store();
      const mainDir = repos.ensure("frontend", repo.dir, "main");
      const bundle = bundleFor({
        repo: {
          id: 2,
          name: "frontend",
          url: repo.dir,
          defaultBranch: "main",
        },
        integrationBranch: "spec/1/order-export",
        domain: null,
      });
      cutIntegrationBranch(
        repos,
        (request) => pushRef(request),
        mainDir,
        bundle,
      );
      return gitOrThrow(repo.dir, ["rev-parse", "spec/1/order-export"]);
    };

    it("starts at afk/setup merged onto the default branch's head, so the gate and the agent read the setup", () => {
      const frontend = origin({ "src/a.ts": "a\n", "AGENTS.md": "# old\n" });
      const setup = pushSetup(frontend, {
        ".sandcastle/gates.yaml": "steps: []\n",
        "AGENTS.md": "# old\n\n## Running unattended\n",
      });
      const head = frontend.commit({ "src/b.ts": "b\n" }, "later on main");

      const start = cut(frontend);

      expect(
        gitOrThrow(frontend.dir, ["log", "-1", "--format=%P%n%an%n%s", start]),
      ).toBe(
        `${head} ${setup}\nafk-worker\nSet up for the AFK platform (afk/setup)`,
      );
      expect(
        gitOrThrow(frontend.dir, ["show", `${start}:.sandcastle/gates.yaml`]),
      ).toBe("steps: []");
      expect(gitOrThrow(frontend.dir, ["show", `${start}:src/b.ts`])).toBe("b");
    });

    it("starts at the default branch once the default branch has the setup", () => {
      const frontend = origin({ "src/a.ts": "a\n" });
      pushSetup(frontend, { ".sandcastle/gates.yaml": "steps: []\n" });
      // a spec that carried it was merged
      gitOrThrow(frontend.dir, [
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "S-1",
        "afk/setup",
      ]);
      const head = gitOrThrow(frontend.dir, ["rev-parse", "main"]);

      expect(cut(frontend)).toBe(head);
    });

    it("refuses a setup that no longer merges, naming the files and what to do", () => {
      const frontend = origin({ "AGENTS.md": "# old\n" });
      pushSetup(frontend, { "AGENTS.md": "# setup\n" });
      frontend.commit({ "AGENTS.md": "# someone else\n" }, "on main");

      expect(() => cut(frontend)).toThrow(
        "afk/setup in frontend no longer merges into main (AGENTS.md): run the afk-setup skill again",
      );
      expect(
        gitOrThrow(frontend.dir, ["branch", "--list", "spec/1/order-export"]),
      ).toBe("");
    });
  });
});
