import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi } from "../test/fake-worker.ts";

// Which code hosts the platform can work on: the ones a worker has credentials for (docs/specs/m3-platform.md
// 「托管类型与接入」).

let db: TestDatabase;
let api: RunningApi;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(createApp({ pool: db.pool }));
});
afterEach(async () => {
  await api.close();
  await db.drop();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const report = (workerId: string, hosts: { host: string; kind: string }[]) =>
  call("POST", "/worker/hosts", { workerId, hosts });

describe("the code hosts the workers report", () => {
  it("are kept, and listed with the worker that last reported each", async () => {
    expect(
      (
        await report("mac", [
          { host: "github.com", kind: "github" },
          { host: "git.corp.example", kind: "gitlab" },
        ])
      ).status,
    ).toBe(200);
    const listed = (await call("GET", "/hosts")).body.hosts;
    expect(listed).toEqual([
      {
        host: "git.corp.example",
        kind: "gitlab",
        workerId: "mac",
        reportedAt: expect.any(String),
      },
      {
        host: "github.com",
        kind: "github",
        workerId: "mac",
        reportedAt: expect.any(String),
      },
    ]);
  });

  it("are written in lower case, and a later report of a host replaces the earlier", async () => {
    await report("mac", [{ host: "Git.Corp.Example", kind: "gitlab" }]);
    await report("thinkpad", [{ host: "git.corp.example", kind: "gitlab" }]);
    expect((await call("GET", "/hosts")).body.hosts).toMatchObject([
      { host: "git.corp.example", workerId: "thinkpad" },
    ]);
  });
});

describe("a repo's host kind", () => {
  async function project() {
    return (await call("POST", "/projects", { name: "shop" })).body
      .id as number;
  }
  const kinds = async () =>
    (
      await db.pool.query("SELECT name, host_kind FROM repos ORDER BY id")
    ).rows.map((r) => [r.name, r.host_kind]);

  it("is the kind a worker reported for its host, whatever the address says", async () => {
    await report("mac", [{ host: "git.corp.example", kind: "gitlab" }]);
    const id = await project();
    await call("POST", `/projects/${id}/repos`, {
      url: "https://git.corp.example/team/sub/api.git",
      name: "backend",
    });
    expect(await kinds()).toEqual([["backend", "gitlab"]]);
  });

  it("may not differ from the project's other repos", async () => {
    await report("mac", [
      { host: "github.com", kind: "github" },
      { host: "git.corp.example", kind: "gitlab" },
    ]);
    const id = await project();
    await call("POST", `/projects/${id}/repos`, {
      url: "https://github.com/me/shop-backend.git",
      name: "backend",
    });
    const mixed = await call("POST", `/projects/${id}/repos`, {
      url: "https://git.corp.example/me/shop-frontend.git",
      name: "frontend",
    });
    expect(mixed.status).toBe(409);
    expect(mixed.body.error).toContain("backend 在 GitHub");
    expect(mixed.body.error).toContain("frontend 在 GitLab");
    expect(mixed.body.error).toContain("搬到同一种托管，或为它单独建项目");
    expect(await kinds()).toEqual([["backend", "github"]]);
  });
});
