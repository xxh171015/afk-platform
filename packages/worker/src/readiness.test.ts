import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitOrThrow,
  SANDBOX_SKILLS_DIR,
  SandcastleGateSandbox,
} from "@afk/pipeline";
import {
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runReadinessGate } from "./readiness.ts";
import { RepoStore } from "./repos.ts";

// `plat repo check`: a worker runs a repo's gate on a pushed branch the way it gates a ticket, so that a repo being
// set up for the platform knows its gates.yaml works in the platform's sandbox. Real origin, real clone cache; the
// sandbox is the fake that runs commands in a worktree.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const junit = Buffer.from(
  '<testsuites tests="3"><testsuite name="a" tests="3" skipped="0"/></testsuites>',
).toString("base64");
const writesJunit = `mkdir -p reports && echo ${junit} | base64 -d > reports/junit.xml`;

function origin(onBranch: Record<string, string>): TestRepo {
  const repo = makeRepo({ "README.md": "r\n" });
  cleanups.push(() => repo.cleanup());
  gitOrThrow(repo.dir, ["switch", "--quiet", "-c", "afk/setup"]);
  repo.commit(onBranch, "Set up for the platform");
  gitOrThrow(repo.dir, ["switch", "--quiet", "main"]);
  return repo;
}

function check(repo: TestRepo, branch = "afk/setup") {
  const root = mkdtempSync(join(tmpdir(), "afk-readiness-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sandboxes: FakeGateSandbox[] = [];
  const result = runReadinessGate(
    {
      repos: new RepoStore(root),
      makeGateSandbox: (dir) => {
        const sandbox = new FakeGateSandbox(dir);
        sandboxes.push(sandbox);
        return sandbox;
      },
    },
    { repo: { name: "backend", url: repo.dir, defaultBranch: "main" }, branch },
    () => {},
  );
  return { result, sandboxes };
}

const gates = (commands: string) => `setup: "true"\ncommands:\n${commands}`;

describe("checking a repo's gate on a branch", () => {
  it("passes when every command passes and the tests are reported, with the gates.yaml of that branch", async () => {
    const repo = origin({
      ".sandcastle/gates.yaml": gates(
        `  - { name: typecheck, run: "true", timeoutSeconds: 30 }\n  - { name: test, run: ${JSON.stringify(writesJunit)}, timeoutSeconds: 30, junit: reports/junit.xml }\n`,
      ),
    });

    const { result, sandboxes } = check(repo);

    expect(await result).toMatchObject({
      stage: "readiness-gate",
      pass: true,
      reasons: [],
      steps: ["setup", "typecheck", "test"],
      tests: 3,
    });
    expect(sandboxes[0]?.opened).toEqual(["afk/setup"]);
  });

  it("gates the default branch too", async () => {
    const repo = makeRepo({
      ".sandcastle/gates.yaml": gates(
        `  - { name: test, run: ${JSON.stringify(writesJunit)}, timeoutSeconds: 30, junit: reports/junit.xml }\n`,
      ),
    });
    cleanups.push(() => repo.cleanup());

    expect(await check(repo, "main").result).toMatchObject({
      pass: true,
      steps: ["setup", "test"],
    });
  });

  it("stops at the first failing command and names it, with the end of its output", async () => {
    const repo = origin({
      ".sandcastle/gates.yaml": gates(
        `  - { name: typecheck, run: "echo src/a.ts is broken; exit 3", timeoutSeconds: 30 }\n  - { name: test, run: "true", timeoutSeconds: 30 }\n`,
      ),
    });

    const outcome = await check(repo).result;

    expect(outcome).toMatchObject({
      pass: false,
      failedStep: "typecheck",
      reasons: ["typecheck failed (exit 3)"],
      steps: ["setup", "typecheck"],
    });
    expect(outcome.log).toContain("src/a.ts is broken");
  });

  it("says what is wrong when the branch has no gates.yaml, or one that cannot be read, or is not there", async () => {
    const none = await check(origin({ "AGENTS.md": "# a\n" })).result;
    expect(none).toMatchObject({
      pass: false,
      reasons: ["afk/setup has no .sandcastle/gates.yaml"],
    });

    const bad = await check(
      origin({ ".sandcastle/gates.yaml": "commands: nope\n" }),
    ).result;
    expect(bad.pass).toBe(false);
    expect(bad.reasons[0]).toMatch(
      /^\.sandcastle\/gates\.yaml on afk\/setup is not valid/,
    );

    const missing = await check(origin({ "a.txt": "a\n" }), "afk/other").result;
    expect(missing).toMatchObject({
      pass: false,
      reasons: ["afk/other is not on the repo's origin: push it first"],
    });
  });

  it("opens the same hardened Sandcastle gate sandbox the ticket gate uses", async () => {
    const repo = origin({
      ".sandcastle/gates.yaml": gates(
        `  - { name: test, run: "true", timeoutSeconds: 30 }\n`,
      ),
    });
    const root = mkdtempSync(join(tmpdir(), "afk-readiness-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const calls: string[][] = [];
    const logDir = mkdtempSync(join(tmpdir(), "afk-sandbox-log-"));
    cleanups.push(() => rmSync(logDir, { recursive: true, force: true }));
    await runReadinessGate(
      {
        repos: new RepoStore(root),
        makeGateSandbox: (dir) =>
          new SandcastleGateSandbox({
            cwd: dir,
            image: "sandcastle:afk-platform",
            model: "m",
            skillsMount: SANDBOX_SKILLS_DIR,
            cursorApiKey: "k",
            logDir,
            docker: (args) => {
              calls.push(args);
              return { code: 0, stdout: "ok\n" };
            },
          }),
      },
      {
        repo: { name: "backend", url: repo.dir, defaultBranch: "main" },
        branch: "afk/setup",
      },
      () => {},
    );
    const run = calls.find((call) => call[0] === "run");
    expect(run, "docker run was not recorded").toBeDefined();
    expect(run).toEqual(expect.arrayContaining(["--cap-drop", "ALL"]));
    expect(run).toEqual(
      expect.arrayContaining(["--security-opt", "no-new-privileges=true"]),
    );
    expect(run).toContain("--init");
    expect(run).toEqual(expect.arrayContaining(["--pids-limit", "4096"]));
    expect(run).toEqual(expect.arrayContaining(["--memory", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--memory-swap", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--cpus", "2"]));
    expect(run).toEqual(expect.arrayContaining(["--shm-size", "1g"]));
    expect(run).toEqual(expect.arrayContaining(["--label", "afk.kind=gate"]));
  });
});
