import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import type { Notice } from "../notify/notices.ts";
import { FakeWorker, listen, type RunningApi } from "../test/fake-worker.ts";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";
import { importBody } from "../test/ticket-files.ts";

// Whether the GitHub App or GitLab PAT can work on a repo: only a worker holds the credentials, so registering a
// repo (and every plat init) queues a `repo-access` job, and what the worker found is kept on the repo for plat
// init to show. After each answer the next check is queued a day later.

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

  it("says when no worker has answered yet", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const result = await ws.plat(backend.dir, ["init", "--yes"]);
    expect(result.stdout).toContain(
      "backend: the GitHub App is not checked yet (no worker has answered)",
    );
  });
});

describe("GitLab repo access", () => {
  it("is checked by a worker when the repo is registered, kept on the repo, and shown by plat init", async () => {
    const web = ws.checkout("web", "https://gitlab.com/acme/web.git");
    await ws.plat(web.dir, ["init", "--yes"]);

    const { job, task } = await claimAccessJob();
    expect(task).toEqual({
      kind: "repo-access",
      repoUrl: "https://gitlab.com/acme/web.git",
    });
    expect(
      (
        await worker.complete(job.id, job.attempt, {
          stage: "repo-access",
          state: "not-member",
          username: "alice",
          fix: "请项目 Maintainer 把〈alice〉加为 Developer",
          hints: [],
        })
      ).status,
    ).toBe(200);

    expect(await get("/projects/1/repos/web/access")).toMatchObject({
      state: "not-member",
      username: "alice",
      fix: "请项目 Maintainer 把〈alice〉加为 Developer",
      hostKind: "gitlab",
    });
    const again = await ws.plat(web.dir, ["init"]);
    expect(again.stdout).toContain(
      "web: 请项目 Maintainer 把〈alice〉加为 Developer",
    );
  });

  it("hints a personal token without blocking confirm, and blocks confirm while the user is not a member", async () => {
    const web = ws.checkout("web", "https://gitlab.com/acme/web.git");
    await ws.plat(web.dir, ["init", "--yes"]);
    const first = await claimAccessJob();
    await worker.complete(first.job.id, first.job.attempt, {
      stage: "repo-access",
      state: "not-member",
      username: "alice",
      fix: "请项目 Maintainer 把〈alice〉加为 Developer",
      hints: [],
    });

    const project = await fetch(`${ws.api.url}/projects`, {
      method: "GET",
    }).then((r) => r.json());
    const spec = await fetch(`${ws.api.url}/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.projects[0].id,
        type: "feature",
        slug: "export",
        title: "Export",
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect(spec.status).toBe(201);
    const imported = await fetch(
      `${ws.api.url}/specs/${spec.body.id}/tickets/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          importBody(spec.body.id, {
            tickets: [
              {
                key: "a",
                repo: "web",
                type: "implementation",
                title: "write it",
                modules: ["src/**"],
                acceptance: ["it works"],
              },
            ],
          }),
        ),
      },
    );
    expect(imported.status).toBe(200);

    const blocked = await fetch(`${ws.api.url}/specs/${spec.body.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: "web: 请项目 Maintainer 把〈alice〉加为 Developer",
    });

    await fetch(`${ws.api.url}/projects/1/repos/web/access-check`, {
      method: "POST",
    });
    const second = await claimAccessJob();
    await worker.complete(second.job.id, second.job.attempt, {
      stage: "repo-access",
      state: "ok",
      username: "alice",
      hints: ["personal-token"],
      files: { gates: true, integrationCompose: false },
    });
    expect((await ws.plat(web.dir, ["init"])).stdout).toContain(
      "平台用的是个人令牌：推送和 MR 显示为〈alice〉",
    );

    const allowed = await fetch(`${ws.api.url}/specs/${spec.body.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(allowed.status).toBe(200);
  });

  it("blocks confirm when the GitLab PAT check failed", async () => {
    const web = ws.checkout("web", "https://gitlab.com/acme/web.git");
    await ws.plat(web.dir, ["init", "--yes"]);
    const { job } = await claimAccessJob();
    await worker.fail(
      job.id,
      job.attempt,
      "GitLab did not describe the token's user: HTTP 401",
    );

    const project = await fetch(`${ws.api.url}/projects`).then((r) => r.json());
    const spec = await fetch(`${ws.api.url}/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.projects[0].id,
        type: "feature",
        slug: "notes",
        title: "Notes",
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect(spec.status).toBe(201);
    const imported = await fetch(
      `${ws.api.url}/specs/${spec.body.id}/tickets/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          importBody(spec.body.id, {
            tickets: [
              {
                key: "a",
                repo: "web",
                type: "implementation",
                title: "write it",
                modules: ["src/**"],
                acceptance: ["it works"],
              },
            ],
          }),
        ),
      },
    );
    expect(imported.status).toBe(200);

    const blocked = await fetch(`${ws.api.url}/specs/${spec.body.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error:
        "web: 托管无法检查：GitLab did not describe the token's user: HTTP 401",
    });
  });

  it("queues the next check a day later, and plat init runs that waiting check now", async () => {
    const web = ws.checkout("web", "https://gitlab.com/acme/web.git");
    await ws.plat(web.dir, ["init", "--yes"]);
    const first = await claimAccessJob();
    const before = Date.now();
    await worker.complete(first.job.id, first.job.attempt, {
      stage: "repo-access",
      state: "ok",
      username: "alice",
      hints: [],
      files: { gates: true, integrationCompose: false },
    });

    const queued = (
      await ws.db.pool.query<{ state: string; not_before: Date | null }>(
        `SELECT state, not_before FROM jobs WHERE type = 'repo-access' AND state = 'queued'`,
      )
    ).rows[0];
    expect(queued).toBeTruthy();
    const delay = (queued.not_before as Date).getTime() - before;
    expect(delay).toBeGreaterThan(24 * 60 * 60 * 1000 - 5_000);
    expect(delay).toBeLessThan(24 * 60 * 60 * 1000 + 5_000);

    expect((await worker.claim()).body.job).toBeNull();

    await ws.plat(web.dir, ["init"]);
    const second = await claimAccessJob();
    expect(second.job.id).toBeGreaterThan(first.job.id);
  });
});

describe("a GitLab PAT's expiry", () => {
  let db: TestDatabase;
  let api: RunningApi;
  let worker: FakeWorker;
  let notices: Notice[];
  const now = new Date("2026-11-09T12:00:00.000Z");

  beforeEach(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    notices = [];
    api = await listen(
      createApp({
        pool: db.pool,
        clock: () => now,
        notifications: {
          async notify(notice) {
            notices.push(notice);
          },
        },
      }),
    );
    worker = new FakeWorker(api.url, "w1", ["host"]);
    await fetch(`${api.url}/worker/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "w1",
        hosts: [{ host: "gitlab.com", kind: "gitlab" }],
      }),
    });
    const project = await fetch(`${api.url}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shop" }),
    }).then((r) => r.json());
    await fetch(`${api.url}/projects/${project.id}/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://gitlab.com/acme/web.git",
        name: "web",
      }),
    });
    await fetch(`${api.url}/projects/${project.id}/repos/web/access-check`, {
      method: "POST",
    });
  });
  afterEach(async () => {
    await api.close();
    await db.drop();
  });

  async function completeAccess(tokenExpiresAt: string) {
    const { body } = await worker.claim();
    const job = body.job as NonNullable<typeof body.job>;
    expect(
      (
        await worker.complete(job.id, job.attempt, {
          stage: "repo-access",
          state: "ok",
          username: "alice",
          hints: [],
          files: { gates: true, integrationCompose: false },
          tokenExpiresAt,
        })
      ).status,
    ).toBe(200);
  }

  it("shows on GET /hosts and notifies once when 30 days remain", async () => {
    await completeAccess("2026-12-09");
    const hosts = await fetch(`${api.url}/hosts`).then((r) => r.json());
    expect(hosts.hosts).toMatchObject([
      {
        host: "gitlab.com",
        kind: "gitlab",
        tokenExpiresAt: "2026-12-09",
        daysLeft: 30,
      },
    ]);
    expect(notices).toEqual([
      {
        title: "GitLab 令牌即将到期",
        body: expect.stringContaining(
          "gitlab.com 的个人令牌将在 2026-12-09 到期（还剩 30 天）",
        ),
      },
    ]);

    await fetch(`${api.url}/projects/1/repos/web/access-check`, {
      method: "POST",
    });
    await completeAccess("2026-12-09");
    expect(notices).toHaveLength(1);

    await fetch(`${api.url}/projects/1/repos/web/access-check`, {
      method: "POST",
    });
    const { body } = await worker.claim();
    const job = body.job as NonNullable<typeof body.job>;
    await worker.complete(job.id, job.attempt, {
      stage: "repo-access",
      state: "ok",
      username: "alice",
      hints: [],
      files: { gates: true, integrationCompose: false },
    });
    const again = await fetch(`${api.url}/hosts`).then((r) => r.json());
    expect(again.hosts[0].tokenExpiresAt).toBe("2026-12-09");
    expect(notices).toHaveLength(1);
  });
});
