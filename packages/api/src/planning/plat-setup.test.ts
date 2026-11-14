import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorker } from "../test/fake-worker.ts";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";

// `plat setup` (the fixed part of the afk-setup skill): one check of the machine that names everything missing, then
// plat init, then a detached setup worktree per repo that origin has no gate or AGENTS.md for, outside the person's
// checkout. The worktrees are where the agent writes the files `plat setup --finish` pushes.

let ws: PlatWorkspace;
let bin: string;

beforeEach(async () => {
  ws = await platWorkspace();
  bin = mkdtempSync(join(tmpdir(), "afk-bin-"));
  symlinkSync(
    spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(),
    join(bin, "git"),
  );
  gh(0);
});
afterEach(async () => {
  await ws.close();
  rmSync(bin, { recursive: true, force: true });
});

// gh on PATH, answering `gh auth status` with `code`; "missing" takes it away.
function gh(code: number | "missing") {
  const file = join(bin, "gh");
  rmSync(file, { force: true });
  if (code === "missing") return;
  writeFileSync(file, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(file, 0o755);
}

// Only git and the stand-in gh: whatever gh this machine has is not on it.
const PATH = () => bin;

const setup = (checkout: Checkout, args: string[] = []) =>
  ws.plat(checkout.dir, ["setup", ...args], undefined, {
    env: { PATH: PATH() },
  });
const setupJson = async (checkout: Checkout, args: string[] = []) => {
  const result = await ws.plat(
    checkout.dir,
    ["--json", "setup", ...args],
    undefined,
    { env: { PATH: PATH() } },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as {
    project: number;
    planningRepo: string;
    ready: boolean;
    repos: {
      name: string;
      worktree: string | null;
      resumed: boolean;
      missing: string[];
      gates: boolean | null;
      agentsMd: string | null;
      runningUnattended: boolean | null;
      hostingOk: boolean | null;
      problem: string | null;
    }[];
  };
};

const SET_UP = {
  ".sandcastle/gates.yaml": "setup: true\n",
  "AGENTS.md": "# Backend\n\n## Running unattended\n\nNobody answers.\n",
};

const worktreeOf = (name: string) => join(ws.afkHome, "setup/backend", name);
const projects = async () =>
  Number(
    (await ws.db.pool.query("SELECT count(*) FROM projects")).rows[0].count,
  );

describe("plat setup checks the machine first", () => {
  it("names everything missing at once and changes nothing", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const plain = mkdtempSync(join(tmpdir(), "afk-plain-"));
    gh(1);

    const result = await setup(backend, [
      "--with",
      "../nowhere",
      "--with",
      plain,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("this machine is not ready");
    expect(result.stderr).toContain("../nowhere: no such directory");
    expect(result.stderr).toContain(`${plain}: not a git checkout`);
    expect(result.stderr).toContain("gh is not logged in");
    expect(await projects()).toBe(0);
    expect(existsSync(join(ws.afkHome, "setup"))).toBe(false);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    rmSync(plain, { recursive: true, force: true });
  });

  it("does not ask for gh when every origin is on GitLab", async () => {
    const backend = ws.checkout(
      "backend",
      "https://gitlab.com/acme/backend.git",
    );
    gh("missing");

    const result = await setup(backend);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await projects()).toBe(1);
  });

  it("says how to install gh when a repo is on GitHub and there is none", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    gh("missing");

    const result = await setup(backend);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("gh is missing");
    expect(result.stderr).toContain("gh auth login");
  });
});

describe("plat setup makes a worktree for each repo origin lacks the setup for", () => {
  it("registers the planning repo and the others, and leaves the person's checkouts as they were", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const frontend = ws.checkout(
      "frontend",
      "https://github.com/acme/frontend.git",
    );
    gitOrThrow(backend.dir, ["checkout", "-q", "-b", "my-work"]);

    const out = await setupJson(backend, ["--with", frontend.dir]);

    expect(out.planningRepo).toBe("backend");
    expect(out.ready).toBe(false);
    expect(out.repos.map((r) => [r.name, r.worktree])).toEqual([
      ["backend", worktreeOf("backend")],
      ["frontend", worktreeOf("frontend")],
    ]);
    expect(out.repos[0]).toMatchObject({
      gates: false,
      agentsMd: "missing",
      runningUnattended: false,
      missing: [".sandcastle/gates.yaml", "AGENTS.md"],
    });
    for (const name of ["backend", "frontend"]) {
      const worktree = worktreeOf(name);
      expect(gitOrThrow(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "HEAD",
      );
      expect(
        gitOrThrow(worktree, ["rev-parse", "HEAD"]) ===
          gitOrThrow(worktree, ["rev-parse", "origin/main"]),
      ).toBe(true);
    }
    // the person's checkouts: same branch, nothing new, no afk/setup branch
    expect(gitOrThrow(backend.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "my-work",
    );
    for (const checkout of [backend, frontend]) {
      expect(gitOrThrow(checkout.dir, ["status", "--porcelain"])).toBe("");
      expect(gitOrThrow(checkout.dir, ["branch", "--list", "afk/setup"])).toBe(
        "",
      );
    }
    expect(existsSync(join(backend.dir, "docs/agents/issue-tracker.md"))).toBe(
      true,
    );

    const text = await setup(backend, ["--with", frontend.dir]);
    expect(text.stdout).toContain(
      `backend (planning repo): worktree ${worktreeOf("backend")}; write .sandcastle/gates.yaml, AGENTS.md`,
    );
    expect(text.stdout).toContain(
      "next: write what each worktree lacks, then plat setup --finish",
    );
    expect(await projects()).toBe(1);
  });

  it("starts from origin's afk/setup and merges the default branch into it", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const origin = backend.origin;
    gitOrThrow(origin.dir, ["checkout", "-q", "-b", "afk/setup"]);
    origin.commit({ ".sandcastle/gates.yaml": "setup: true\n" }, "Add a gate");
    gitOrThrow(origin.dir, ["checkout", "-q", "main"]);
    origin.commit({ "src/new.ts": "export {};\n" }, "New code");

    const out = await setupJson(backend);

    const worktree = worktreeOf("backend");
    expect(out.repos[0]).toMatchObject({
      gates: true,
      agentsMd: "missing",
      missing: ["AGENTS.md"],
    });
    expect(existsSync(join(worktree, "src/new.ts"))).toBe(true);
    expect(
      gitOrThrow(worktree, [
        "merge-base",
        "--is-ancestor",
        "origin/afk/setup",
        "HEAD",
      ]),
    ).toBe("");

    // the merge is not work of its own: a second run makes the worktree again, the same way
    const again = await setupJson(backend);
    expect(again.repos[0]).toMatchObject({
      resumed: false,
      missing: ["AGENTS.md"],
    });
  });

  it("carries on in a worktree with work of its own, and makes one without it again", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const frontend = ws.checkout(
      "frontend",
      "https://github.com/acme/frontend.git",
    );
    await setupJson(backend, ["--with", frontend.dir]);
    writeFileSync(join(worktreeOf("backend"), "AGENTS.md"), "# Backend\n");
    writeFileSync(join(worktreeOf("frontend"), "scratch.txt"), "x\n");
    gitOrThrow(worktreeOf("frontend"), ["stash", "-u", "-q"]);

    const out = await setupJson(backend, ["--with", frontend.dir]);

    expect(out.repos.map((r) => [r.name, r.resumed])).toEqual([
      ["backend", true],
      ["frontend", false],
    ]);
    expect(readFileSync(join(worktreeOf("backend"), "AGENTS.md"), "utf8")).toBe(
      "# Backend\n",
    );
    expect(out.repos[0]).toMatchObject({
      agentsMd: "present",
      runningUnattended: false,
      missing: [".sandcastle/gates.yaml", "AGENTS.md#Running unattended"],
    });
  });

  it("removes an older afk-setup's clean leftovers and keeps ones with work in them", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const frontend = ws.checkout(
      "frontend",
      "https://github.com/acme/frontend.git",
    );
    for (const checkout of [backend, frontend])
      gitOrThrow(checkout.dir, [
        "worktree",
        "add",
        "-q",
        "-b",
        "afk/setup",
        `${checkout.dir}-afk-setup`,
        "origin/main",
      ]);
    writeFileSync(join(`${frontend.dir}-afk-setup`, "wip.txt"), "wip\n");

    const result = await setup(backend, ["--with", frontend.dir]);

    expect(result.stdout).toContain(
      "backend: removed what an older afk-setup left: backend-afk-setup and local afk/setup branch",
    );
    expect(result.stdout).toContain(
      "frontend: frontend-afk-setup kept: it has uncommitted changes",
    );
    expect(existsSync(`${backend.dir}-afk-setup`)).toBe(false);
    expect(gitOrThrow(backend.dir, ["branch", "--list", "afk/setup"])).toBe("");
    expect(existsSync(join(`${frontend.dir}-afk-setup`, "wip.txt"))).toBe(true);
  });
});

describe("plat setup and an older afk-setup's worktree with commits origin lacks", () => {
  it("keeps a detached one whose commits are not pushed", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const old = `${backend.dir}-afk-setup`;
    gitOrThrow(backend.dir, [
      "worktree",
      "add",
      "-q",
      "--detach",
      old,
      "origin/main",
    ]);
    writeFileSync(join(old, "AGENTS.md"), "# mine\n");
    gitOrThrow(old, ["add", "-A"]);
    gitOrThrow(old, ["commit", "-q", "-m", "Mine"]);

    const result = await setup(backend);

    expect(result.stdout).toContain(
      "backend: backend-afk-setup kept: it has commits origin does not",
    );
    expect(readFileSync(join(old, "AGENTS.md"), "utf8")).toBe("# mine\n");
  });
});

describe("plat setup on a project set up already", () => {
  it("on another machine, only writes this machine's planning files and says 本机已就绪", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      SET_UP,
    );
    // someone registered it from their machine
    await ws.plat(backend.dir, ["init", "--yes"]);
    rmSync(join(backend.dir, "docs/agents/issue-tracker.md"));

    const result = await setup(backend);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "backend (planning repo): set up on origin, nothing to do",
    );
    expect(result.stdout).toContain("本机已就绪");
    expect(existsSync(join(ws.afkHome, "setup/backend"))).toBe(false);
    expect(existsSync(join(backend.dir, "docs/agents/issue-tracker.md"))).toBe(
      true,
    );
    expect(await projects()).toBe(1);
  });

  it("mid-planning, sets up only the repo that was added and rewrites the tracker doc here", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      SET_UP,
    );
    const frontend = ws.checkout(
      "frontend",
      "https://github.com/acme/frontend.git",
    );
    await setup(backend);
    const doc = join(backend.dir, "docs/agents/issue-tracker.md");
    const before = readFileSync(doc, "utf8");

    const out = await setupJson(backend, ["--with", frontend.dir]);

    expect(out.repos.map((r) => [r.name, r.worktree])).toEqual([
      ["backend", null],
      ["frontend", worktreeOf("frontend")],
    ]);
    // two repos now: the tracker doc gains the integration rules
    expect(readFileSync(doc, "utf8")).not.toBe(before);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  });

  it("makes a worktree again when afk/setup no longer merges into the default branch", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      SET_UP,
    );
    const origin = backend.origin;
    gitOrThrow(origin.dir, ["checkout", "-q", "-b", "afk/setup"]);
    origin.commit({ "AGENTS.md": "# setup's\n" }, "Setup's AGENTS.md");
    gitOrThrow(origin.dir, ["checkout", "-q", "main"]);
    origin.commit({ "AGENTS.md": "# main's\n" }, "Main's AGENTS.md");
    mkdirSync(ws.afkHome, { recursive: true });

    const result = await setup(backend);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "origin/main does not merge into afk/setup cleanly",
    );
    expect(result.stderr).not.toContain("本机已就绪");
  });
});

describe("plat setup --finish", () => {
  const PASS = {
    pass: true,
    reasons: [],
    steps: ["setup", "test"],
    tests: 3,
    skipped: 0,
  };
  const FAIL = {
    pass: false,
    reasons: ["test failed (exit 127)"],
    steps: ["setup", "test"],
    failedStep: "test",
    log: "sh: 1: cargo: command not found",
  };

  // The worker's side: answer `count` readiness-gate jobs, each with the result for its repo.
  async function answerGates(
    results: Record<string, Record<string, unknown>>,
    count: number,
  ) {
    const worker = new FakeWorker(ws.api.url, "w1");
    for (let answered = 0, i = 0; answered < count && i < 500; i++) {
      const { body } = await worker.claim();
      if (!body.job) {
        await new Promise((done) => setTimeout(done, 20));
        continue;
      }
      expect(body.job.type).toBe("readiness-gate");
      const task = await (
        await fetch(
          `${ws.api.url}/worker/jobs/${body.job.id}/readiness-task?workerId=w1&attempt=${body.job.attempt}`,
        )
      ).json();
      await worker.complete(body.job.id, body.job.attempt, {
        stage: "readiness-gate",
        ...results[task.repo.name],
      });
      answered++;
    }
  }

  const finish = (checkout: Checkout) =>
    ws.plat(checkout.dir, ["setup", "--finish"], undefined, {
      env: { PATH: PATH() },
    });

  it("commits what was written, pushes afk/setup, removes the worktree once the gate passes, and runs plat doctor", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      { "README.md": "r\n", "AGENTS.md": "# old\n" },
    );
    await setup(backend);
    const worktree = worktreeOf("backend");
    mkdirSync(join(worktree, ".sandcastle"), { recursive: true });
    writeFileSync(join(worktree, ".sandcastle/gates.yaml"), "setup: true\n");
    writeFileSync(
      join(worktree, "AGENTS.md"),
      "# Backend\n\n## Running unattended\n\nNobody answers.\n",
    );

    const [result] = await Promise.all([
      finish(backend),
      answerGates({ backend: PASS }, 1),
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const message = gitOrThrow(backend.origin.dir, [
      "log",
      "-1",
      "--format=%B",
      "afk/setup",
    ]);
    expect(message).toContain("Set the repo up for the AFK platform");
    expect(message).toContain("Added: .sandcastle/gates.yaml");
    expect(message).toContain("Replaced: AGENTS.md");
    expect(result.stdout).toMatch(
      /backend \(planning repo\): afk\/setup pushed \([0-9a-f]+\); gate passed/,
    );
    expect(result.stdout).toContain("next: plan with /grill-with-docs");
    expect(existsSync(join(ws.afkHome, "setup"))).toBe(true);
    expect(existsSync(join(ws.afkHome, "setup/backend"))).toBe(false);
    expect(
      gitOrThrow(backend.dir, ["worktree", "list"]).split("\n"),
    ).toHaveLength(1);
    const stored = await (
      await fetch(`${ws.api.url}/projects/1/doctor-report`)
    ).json();
    expect(stored.report.items.map((i: { id: string }) => i.id)).toContain(
      "skills",
    );
  });

  it("keeps the worktree of a repo whose gate fails, says the sandbox lacks a tool, and finishes the others", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const frontend = ws.checkout(
      "frontend",
      "https://github.com/acme/frontend.git",
    );
    await setup(backend, ["--with", frontend.dir]);
    for (const name of ["backend", "frontend"]) {
      mkdirSync(join(worktreeOf(name), ".sandcastle"), { recursive: true });
      writeFileSync(join(worktreeOf(name), ".sandcastle/gates.yaml"), "x\n");
      writeFileSync(join(worktreeOf(name), "AGENTS.md"), "# a\n");
    }

    const [result] = await Promise.all([
      finish(backend),
      answerGates({ backend: PASS, frontend: FAIL }, 2),
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("frontend: afk/setup pushed");
    expect(result.stderr).toContain(
      `worktree kept at ${worktreeOf("frontend")}`,
    );
    expect(result.stderr).toContain(
      "frontend: the platform's sandbox lacks a tool this repo needs",
    );
    expect(result.stderr).toContain("cargo: command not found");
    expect(existsSync(worktreeOf("backend"))).toBe(false);
    expect(existsSync(worktreeOf("frontend"))).toBe(true);

    // fixed (here: the platform's image got the tool): only frontend again, nothing new to commit
    const before = gitOrThrow(frontend.origin.dir, ["rev-parse", "afk/setup"]);
    const [again] = await Promise.all([
      finish(backend),
      answerGates({ frontend: PASS }, 1),
    ]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(
      "frontend: afk/setup up to date; gate passed",
    );
    expect(again.stdout).toContain("backend (planning repo): set up on origin");
    expect(gitOrThrow(frontend.origin.dir, ["rev-parse", "afk/setup"])).toBe(
      before,
    );
    expect(existsSync(join(ws.afkHome, "setup/backend"))).toBe(false);
  });

  it("says to run plat setup first in a checkout with no tracker doc", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const result = await finish(backend);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("run plat setup first");
  });
});
