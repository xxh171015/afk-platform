import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorker } from "../test/fake-worker.ts";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";

// Whether the GitHub App can work on a repo: only a worker holds the App's credentials, so registering a repo (and
// every plat init) queues a `repo-access` job, and what the worker found is kept on the repo for plat init to show.

let ws: PlatWorkspace;
let worker: FakeWorker;

beforeEach(async () => {
  ws = await platWorkspace();
  worker = new FakeWorker(ws.api.url, "w1", ["host"]);
});
afterEach(async () => {
  await ws.close();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function get(path: string): Promise<Json> {
  return (await fetch(`${ws.api.url}${path}`)).json();
}

async function claimAccessJob() {
  const { body } = await worker.claim();
  expect(body.job?.type).toBe("repo-access");
  const job = body.job as NonNullable<typeof body.job>;
  const task = await get(
    `/worker/jobs/${job.id}/host-task?workerId=w1&attempt=${job.attempt}`,
  );
  return { job, task };
}

describe("the GitHub App's access to a repo", () => {
  it("is checked by a worker when the repo is registered, kept on the repo, and shown by plat init", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);

    const { job, task } = await claimAccessJob();
    expect(task).toEqual({
      kind: "repo-access",
      repoUrl: "https://github.com/acme/backend.git",
    });
    expect(
      (
        await worker.complete(job.id, job.attempt, {
          stage: "repo-access",
          state: "not-installed",
          fixUrl: "https://github.com/apps/afk-bot/installations/new",
        })
      ).status,
    ).toBe(200);

    expect(await get("/projects/1/repos/backend/access")).toMatchObject({
      state: "not-installed",
      fixUrl: "https://github.com/apps/afk-bot/installations/new",
    });
    const again = await ws.plat(backend.dir, ["init"]);
    expect(again.stdout).toContain(
      "backend: the GitHub App is not installed on this repo; install it (whoever runs the platform): https://github.com/apps/afk-bot/installations/new",
    );
  });

  it("names the permissions the App lacks", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);
    const { job } = await claimAccessJob();
    await worker.complete(job.id, job.attempt, {
      stage: "repo-access",
      state: "missing-permissions",
      missing: ["contents: write"],
      fixUrl: "https://github.com/settings/installations/7",
    });

    const again = await ws.plat(backend.dir, ["init"]);

    expect(again.stdout).toContain(
      "backend: the GitHub App lacks contents: write; grant it (whoever runs the platform): https://github.com/settings/installations/7",
    );
  });

  it("is checked again on every plat init, and a check that fails is kept as an error", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);
    const first = await claimAccessJob();
    await worker.complete(first.job.id, first.job.attempt, {
      stage: "repo-access",
      state: "ok",
    });
    expect((await ws.plat(backend.dir, ["init"])).stdout).toContain(
      "backend: the GitHub App can work here",
    );

    const second = await claimAccessJob();
    await worker.fail(second.job.id, second.job.attempt, "GitHub is down");

    expect(await get("/projects/1/repos/backend/access")).toMatchObject({
      state: "error",
      message: "GitHub is down",
    });
    expect((await worker.claim()).body.job).toBeNull();
  });

  it("says when no worker has answered yet, and leaves GitLab repos unchecked", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const web = ws.checkout("web", "https://gitlab.com/acme/web.git");

    const result = await ws.plat(backend.dir, [
      "init",
      "--with",
      web.dir,
      "--yes",
    ]);

    expect(result.stdout).toContain(
      "backend: the GitHub App is not checked yet (no worker has answered)",
    );
    expect(result.stdout).toContain("web: not checked (only GitHub is)");
    expect(await get("/projects/1/repos/web/access")).toEqual({
      state: "unchecked",
    });
  });
});
