import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { bundleFor, makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  cutIntegrationBranch,
  fetchDomain,
  recutIntegrationBranch,
} from "./domain.ts";
import { type PushFn, pushRef } from "./push.ts";
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
  it("reads GLOSSARY and ADRs at the planning SHA and omits AGENTS.md", async () => {
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
      await fetchDomain(
        store(),
        { ...SHA, url: planning.dir, sha },
        "frontend",
      ),
    ).toEqual([
      { path: "GLOSSARY.md", content: "# v2\n" },
      { path: "docs/adr/0001.md", content: "# adr2\n" },
    ]);
  });

  it("does not mount domain files for the planning repo's own tickets", async () => {
    const planning = origin({ "GLOSSARY.md": "# t\n" });
    const sha = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    expect(
      await fetchDomain(store(), { ...SHA, url: planning.dir, sha }, "backend"),
    ).toBeUndefined();
  });

  it("gives nothing when confirm stored no planning commit", async () => {
    expect(await fetchDomain(store(), null, "frontend")).toBeUndefined();
  });
});

describe("cutIntegrationBranch", () => {
  it("starts the planning repo's integration branch at the planning SHA, not at main", async () => {
    const planning = origin({ "GLOSSARY.md": "# v1\n" });
    const initial = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    const sha = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning");
    gitOrThrow(planning.dir, ["update-ref", "refs/heads/plan/s", sha]);
    gitOrThrow(planning.dir, ["update-ref", "refs/heads/main", initial]);

    const repos = store();
    const mainDir = await repos.ensure("backend", planning.dir, "main");
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
    await cutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      bundle,
    );
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(sha);
    expect(gitOrThrow(planning.dir, ["rev-parse", "spec/1/order-export"])).toBe(
      sha,
    );
    expect(sha).not.toBe(initial);
  });

  it("starts another repo's integration branch at its default branch", async () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    const head = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = await repos.ensure("frontend", frontend.dir, "main");
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
    await cutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      bundle,
    );
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      head,
    );
  });

  it("starts at master when that is the repo's default branch", async () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    gitOrThrow(frontend.dir, ["branch", "-m", "main", "master"]);
    const head = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = await repos.ensure("frontend", frontend.dir, "master");
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
    await cutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      bundle,
    );
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      head,
    );
  });

  it("leaves an integration branch that already exists", async () => {
    const planning = origin({ "GLOSSARY.md": "# v1\n" });
    const first = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    const later = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning");
    const repos = store();
    const mainDir = await repos.ensure("backend", planning.dir, "main");
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
    await cutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      bundle,
    );
    expect(gitOrThrow(mainDir, ["rev-parse", "spec/1/order-export"])).toBe(
      first,
    );
  });

  describe("with an afk/setup branch on origin", () => {
    const cut = async (repo: TestRepo) => {
      const repos = store();
      const mainDir = await repos.ensure("frontend", repo.dir, "main");
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
      await cutIntegrationBranch(
        repos,
        (request) => pushRef(request),
        mainDir,
        bundle,
      );
      return gitOrThrow(repo.dir, ["rev-parse", "spec/1/order-export"]);
    };

    it("starts at afk/setup merged onto the default branch's head, so the gate and the agent read the setup", async () => {
      const frontend = origin({ "src/a.ts": "a\n", "AGENTS.md": "# old\n" });
      const setup = pushSetup(frontend, {
        ".sandcastle/gates.yaml": "steps: []\n",
        "AGENTS.md": "# old\n\n## Running unattended\n",
      });
      const head = frontend.commit({ "src/b.ts": "b\n" }, "later on main");

      const start = await cut(frontend);

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

    it("starts at the default branch once the default branch has the setup", async () => {
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

      expect(await cut(frontend)).toBe(head);
    });

    it("refuses a setup that no longer merges, naming the files and what to do", async () => {
      const frontend = origin({ "AGENTS.md": "# old\n" });
      pushSetup(frontend, { "AGENTS.md": "# setup\n" });
      frontend.commit({ "AGENTS.md": "# someone else\n" }, "on main");

      await expect(cut(frontend)).rejects.toThrow(
        "afk/setup in frontend no longer merges into main (AGENTS.md): run the afk-setup skill again",
      );
      expect(
        gitOrThrow(frontend.dir, ["branch", "--list", "spec/1/order-export"]),
      ).toBe("");
    });
  });

  describe("when creating the branch loses a race", () => {
    const BRANCH = "spec/1/order-export";
    const LOCK_REF =
      "! [remote rejected] spec/1/order-export (cannot lock ref 'refs/heads/spec/1/order-export')";

    const rejectCreate: PushFn = async (request) => {
      expect(request.expectedOld).toBe("");
      return { ok: false, error: LOCK_REF };
    };

    async function clonedPlanning() {
      const planning = origin({ "GLOSSARY.md": "# v1\n" });
      const initial = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
      const sha = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning");
      const repos = store();
      const mainDir = await repos.ensure("backend", planning.dir, "main");
      const bundle = bundleFor({
        repo: {
          id: 1,
          name: "backend",
          url: planning.dir,
          defaultBranch: "main",
        },
        integrationBranch: BRANCH,
        domain: {
          repo: "backend",
          url: planning.dir,
          defaultBranch: "main",
          sha,
        },
      });
      return { planning, initial, sha, repos, mainDir, bundle };
    }

    it("returns when creating the branch is rejected and the remote already has it at the start commit", async () => {
      const { planning, sha, repos, mainDir, bundle } = await clonedPlanning();
      gitOrThrow(planning.dir, ["update-ref", `refs/heads/${BRANCH}`, sha]);
      const logs: string[] = [];

      await cutIntegrationBranch(repos, rejectCreate, mainDir, bundle, (line) =>
        logs.push(line),
      );

      expect(gitOrThrow(mainDir, ["rev-parse", BRANCH])).toBe(sha);
      expect(gitOrThrow(planning.dir, ["rev-parse", BRANCH])).toBe(sha);
      expect(logs).toContain(
        `integration branch ${BRANCH} was created by another job`,
      );
    });

    it("returns when creating the branch is rejected and the remote has moved past the start commit", async () => {
      const { planning, sha, repos, mainDir, bundle } = await clonedPlanning();
      gitOrThrow(planning.dir, ["checkout", "--quiet", "-b", BRANCH, sha]);
      const later = planning.commit({ "GLOSSARY.md": "# v3\n" }, "another job");
      gitOrThrow(planning.dir, ["checkout", "--quiet", "main"]);
      const logs: string[] = [];

      await cutIntegrationBranch(repos, rejectCreate, mainDir, bundle, (line) =>
        logs.push(line),
      );

      expect(later).not.toBe(sha);
      expect(gitOrThrow(mainDir, ["rev-parse", BRANCH])).toBe(later);
      expect(gitOrThrow(planning.dir, ["rev-parse", BRANCH])).toBe(later);
      expect(logs).toContain(
        `integration branch ${BRANCH} was created by another job`,
      );
    });

    it("throws when creating the branch is rejected and the remote branch does not contain the start commit", async () => {
      const { planning, initial, sha, repos, mainDir, bundle } =
        await clonedPlanning();
      gitOrThrow(planning.dir, ["update-ref", `refs/heads/${BRANCH}`, initial]);
      expect(initial).not.toBe(sha);

      await expect(
        cutIntegrationBranch(repos, rejectCreate, mainDir, bundle),
      ).rejects.toThrow(`could not create ${BRANCH}: ${LOCK_REF}`);
    });

    it("throws the push error when creating the branch is rejected and the remote has no such branch", async () => {
      const { repos, mainDir, bundle } = await clonedPlanning();

      await expect(
        cutIntegrationBranch(repos, rejectCreate, mainDir, bundle),
      ).rejects.toThrow(`could not create ${BRANCH}: ${LOCK_REF}`);
    });
  });
});

describe("recutIntegrationBranch", () => {
  const BRANCH = "spec/1/order-export";

  it("force-updates an existing integration branch from current main and pushes with lease of the old tip", async () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    const first = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = await repos.ensure("frontend", frontend.dir, "main");
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${BRANCH}`, first]);
    gitOrThrow(frontend.dir, ["update-ref", `refs/heads/${BRANCH}`, first]);
    const later = frontend.commit({ "src/b.ts": "b\n" }, "fix on main");
    await repos.ensure("frontend", frontend.dir, "main");
    const expectedOld: string[] = [];
    await recutIntegrationBranch(
      repos,
      async (request) => {
        expectedOld.push(request.expectedOld ?? "missing");
        return pushRef(request);
      },
      mainDir,
      {
        repo: {
          name: "frontend",
          url: frontend.dir,
          defaultBranch: "main",
        },
        branch: BRANCH,
        mainSha: later,
      },
    );
    expect(later).not.toBe(first);
    expect(gitOrThrow(mainDir, ["rev-parse", BRANCH])).toBe(later);
    expect(gitOrThrow(frontend.dir, ["rev-parse", BRANCH])).toBe(later);
    expect(expectedOld).toEqual([first]);
  });

  it("replays the planning commit onto the new setup base", async () => {
    const planning = origin({
      "src/a.ts": "a\n",
      "GLOSSARY.md": "# v1\n",
    });
    const first = gitOrThrow(planning.dir, ["rev-parse", "HEAD"]);
    const docs = planning.commit({ "GLOSSARY.md": "# v2\n" }, "planning docs");
    gitOrThrow(planning.dir, ["update-ref", `refs/heads/${BRANCH}`, docs]);
    gitOrThrow(planning.dir, ["checkout", "--quiet", "-B", "main", first]);
    const later = planning.commit({ "src/b.ts": "b\n" }, "fix on main");
    const repos = store();
    const mainDir = await repos.ensure("backend", planning.dir, "main");
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${BRANCH}`, docs]);
    await recutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      {
        repo: {
          name: "backend",
          url: planning.dir,
          defaultBranch: "main",
        },
        branch: BRANCH,
        mainSha: later,
        planningSha: docs,
      },
    );
    const tip = gitOrThrow(mainDir, ["rev-parse", BRANCH]);
    expect(tip).not.toBe(docs);
    expect(tip).not.toBe(later);
    expect(gitOrThrow(mainDir, ["show", `${tip}:GLOSSARY.md`])).toBe("# v2");
    expect(gitOrThrow(mainDir, ["show", `${tip}:src/b.ts`])).toBe("b");
    expect(gitOrThrow(planning.dir, ["rev-parse", BRANCH])).toBe(tip);
  });

  it("starts at setupBase only when planning was waived", async () => {
    const frontend = origin({ "src/a.ts": "a\n" });
    const setup = pushSetup(frontend, {
      ".sandcastle/gates.yaml": "steps: []\n",
    });
    const first = gitOrThrow(frontend.dir, ["rev-parse", "HEAD"]);
    const repos = store();
    const mainDir = await repos.ensure("frontend", frontend.dir, "main");
    gitOrThrow(mainDir, ["update-ref", `refs/heads/${BRANCH}`, first]);
    gitOrThrow(frontend.dir, ["update-ref", `refs/heads/${BRANCH}`, first]);
    const later = frontend.commit({ "src/b.ts": "b\n" }, "fix on main");
    await repos.ensure("frontend", frontend.dir, "main");
    await recutIntegrationBranch(
      repos,
      (request) => pushRef(request),
      mainDir,
      {
        repo: {
          name: "frontend",
          url: frontend.dir,
          defaultBranch: "main",
        },
        branch: BRANCH,
        mainSha: later,
      },
    );
    const tip = gitOrThrow(frontend.dir, ["rev-parse", BRANCH]);
    expect(
      gitOrThrow(frontend.dir, ["log", "-1", "--format=%P%n%an%n%s", tip]),
    ).toBe(
      `${later} ${setup}\nafk-worker\nSet up for the AFK platform (afk/setup)`,
    );
    expect(
      gitOrThrow(frontend.dir, ["show", `${tip}:.sandcastle/gates.yaml`]),
    ).toBe("steps: []");
    expect(gitOrThrow(frontend.dir, ["show", `${tip}:src/b.ts`])).toBe("b");
  });
});
