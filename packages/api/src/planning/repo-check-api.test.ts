import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorker } from "../test/fake-worker.ts";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";

// `plat repo check`: the platform runs a repo's gate on a pushed branch in its own sandbox (a worker does), and the
// person (or /afk-setup) gets the answer: which command failed and the end of its output.

let ws: PlatWorkspace;
let worker: FakeWorker;

beforeEach(async () => {
  ws = await platWorkspace();
  worker = new FakeWorker(ws.api.url, "w1");
});
afterEach(async () => {
  await ws.close();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function get(path: string): Promise<Json> {
  return (await fetch(`${ws.api.url}${path}`)).json();
}

// The worker's side: take the readiness-gate job, read what to run, answer with `result`.
async function answer(result: Record<string, unknown>) {
  for (let i = 0; i < 100; i++) {
    const { body } = await worker.claim();
    if (body.job) {
      expect(body.job.type).toBe("readiness-gate");
      const task = await get(
        `/worker/jobs/${body.job.id}/readiness-task?workerId=w1&attempt=${body.job.attempt}`,
      );
      await worker.complete(body.job.id, body.job.attempt, {
        stage: "readiness-gate",
        ...result,
      });
      return task;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("no readiness-gate job was queued");
}

async function registered() {
  const backend = ws.checkout("backend", "https://github.com/acme/backend.git");
  await ws.plat(backend.dir, ["init", "--yes"]);
  return backend;
}

describe("plat repo check", () => {
  it("has a worker run the gate on the branch, in the project of this checkout, and says it passed", async () => {
    const backend = await registered();

    const [result, task] = await Promise.all([
      ws.plat(backend.dir, [
        "repo",
        "check",
        "backend",
        "--branch",
        "afk/setup",
      ]),
      answer({
        pass: true,
        reasons: [],
        steps: ["setup", "typecheck", "test"],
        tests: 12,
        skipped: 0,
      }),
    ]);

    expect(task).toEqual({
      repo: {
        name: "backend",
        url: "https://github.com/acme/backend.git",
        defaultBranch: "main",
      },
      branch: "afk/setup",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "backend afk/setup: the gate passed in the platform's sandbox (setup, typecheck, test; 12 tests)",
    );
  });

  it("fails with the command that failed and the end of its output", async () => {
    const backend = await registered();

    const [result] = await Promise.all([
      ws.plat(backend.dir, ["repo", "check", "backend"]),
      answer({
        pass: false,
        reasons: ["typecheck failed (exit 2)"],
        steps: ["setup", "typecheck"],
        failedStep: "typecheck",
        log: "src/a.ts(3,1): error TS2304",
      }),
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain(
      "backend afk/setup: the gate failed: typecheck failed (exit 2)",
    );
    expect(result.stdout).toContain("src/a.ts(3,1): error TS2304");
  });

  it("refuses a repo the project does not have", async () => {
    const backend = await registered();
    const result = await ws.plat(backend.dir, ["repo", "check", "web"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no such repo");
  });
});
