import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi } from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

// Planning commit: confirm records a SHA the CLI already checked, the page confirms without one,
// and other-repo tickets later see that SHA as /context/domain/ (docs/adr/0003, issue #139).

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

async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
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

const SHA = "0123456789abcdef0123456789abcdef01234567";

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

async function draftSpec(tickets: Record<string, unknown>[]) {
  const project = await call("POST", "/projects", { name: "shop" });
  const projectId = project.body.id as number;
  for (const name of ["backend", "frontend"]) {
    await call("POST", `/projects/${projectId}/repos`, {
      url: `git@x:${name}`,
      name,
    });
  }
  const spec = await call("POST", "/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  const specId = spec.body.id as number;
  const imported = await call(
    "POST",
    `/specs/${specId}/tickets/import`,
    importBody(specId, { tickets }),
  );
  expect(imported.status).toBe(200);
  return { projectId, specId };
}

describe("confirming with a planning commit", () => {
  it("stores the SHA, names the planning repo, and still queues tickets", async () => {
    const { specId } = await draftSpec([ticket("a"), ticket("fe", { repo: "frontend" })]);
    const confirmed = await call("POST", `/specs/${specId}/confirm`, {
      planningSha: SHA,
      planningRepo: "backend",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe("running");
    expect(confirmed.body.planningSha).toBe(SHA);
    expect(confirmed.body.planningRepo).toBe("backend");
    expect(confirmed.body.enqueued).toMatchObject([
      { ticketId: 1, displayId: "T-1" },
      { ticketId: 2, displayId: "T-2" },
    ]);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.body.spec.planningSha).toBe(SHA);
    expect(view.body.spec.planningRepo).toBe("backend");
    expect(view.body.spec.prechecks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-planning-commit" }),
      ]),
    );
  });

  it("puts the planning repo on the spec's integration branches even when it has no tickets", async () => {
    const { specId } = await draftSpec([ticket("fe", { repo: "frontend" })]);
    const confirmed = await call("POST", `/specs/${specId}/confirm`, {
      planningSha: SHA,
      planningRepo: "backend",
    });
    expect(confirmed.status).toBe(200);
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM instance"))
      .rows[0].id;
    expect(confirmed.body.integrationBranches).toEqual([
      { repoId: 1, branch: `spec/${id}/order-export` },
      { repoId: 2, branch: `spec/${id}/order-export` },
    ]);
  });

  it("does not create git branches or commit for the caller", async () => {
    const { specId } = await draftSpec([ticket("a")]);
    const confirmed = await call("POST", `/specs/${specId}/confirm`, {
      planningSha: SHA,
      planningRepo: "backend",
    });
    expect(confirmed.status).toBe(200);
    const jobs = await db.pool.query("SELECT type FROM jobs");
    expect(jobs.rows.map((r) => r.type)).toEqual(["agent-run"]);
  });

  it("refuses a SHA without a planning repo, a repo the project does not have, and a truncated SHA", async () => {
    const { specId } = await draftSpec([ticket("a")]);
    expect(
      (await call("POST", `/specs/${specId}/confirm`, { planningSha: SHA }))
        .status,
    ).toBe(422);
    expect(
      (
        await call("POST", `/specs/${specId}/confirm`, {
          planningRepo: "backend",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("POST", `/specs/${specId}/confirm`, {
          planningSha: SHA,
          planningRepo: "mobile",
        })
      ).body.error,
    ).toMatch(/mobile/);
    expect(
      (
        await call("POST", `/specs/${specId}/confirm`, {
          planningSha: "abc",
          planningRepo: "backend",
        })
      ).status,
    ).toBe(400);
  });
});

describe("confirming without a planning commit", () => {
  it("still runs the spec, and the view marks the missing CLI check yellow", async () => {
    const { specId } = await draftSpec([
      ticket("a", { modules: ["src/x/**"] }),
      ticket("b", { modules: ["src/x/y.ts"] }),
    ]);
    const before = await call("GET", `/specs/${specId}`);
    expect(before.body.spec.planningSha).toBeNull();
    expect(before.body.spec.prechecks).toEqual(
      expect.arrayContaining([
        {
          code: "missing-planning-commit",
          level: "yellow",
          message: "未做规划仓库 CLI 检查",
        },
        expect.objectContaining({
          code: "module-overlap",
          level: "yellow",
        }),
      ]),
    );

    const confirmed = await call("POST", `/specs/${specId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe("running");
    expect(confirmed.body.planningSha).toBeNull();

    const after = await call("GET", `/specs/${specId}`);
    expect(after.body.spec.planningSha).toBeNull();
    expect(after.body.spec.prechecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-planning-commit" }),
      ]),
    );
  });
});

describe("the bundle of a ticket", () => {
  it("carries the planning commit on every ticket of the spec", async () => {
    const { specId } = await draftSpec([
      ticket("be"),
      ticket("fe", { repo: "frontend" }),
    ]);
    expect(
      (
        await call("POST", `/specs/${specId}/confirm`, {
          planningSha: SHA,
          planningRepo: "backend",
        })
      ).status,
    ).toBe(200);

    const claimBundle = async (workerId: string) => {
      const claimed = await call("POST", "/worker/jobs/claim", {
        workerId,
        capabilities: [],
      });
      const job = claimed.body.job as {
        id: number;
        attempt: number;
        payload: { ticketId: number };
      };
      const bundle = await call(
        "GET",
        `/worker/jobs/${job.id}/bundle?workerId=${workerId}&attempt=${job.attempt}`,
      );
      return { ticketId: job.payload.ticketId, bundle: bundle.body };
    };

    const first = await claimBundle("w1");
    const second = await claimBundle("w2");
    const byTicket = [first, second].sort((a, b) => a.ticketId - b.ticketId);
    expect(byTicket[0]?.ticketId).toBe(1);
    const domain = {
      repo: "backend",
      url: "git@x:backend",
      defaultBranch: "main",
      sha: SHA,
    };
    expect(byTicket[0]?.bundle.domain).toEqual(domain);
    expect(byTicket[1]?.bundle.domain).toEqual(domain);
  });

  it("has no domain pointer when confirm did not register a planning commit", async () => {
    const { specId } = await draftSpec([ticket("fe", { repo: "frontend" })]);
    await call("POST", `/specs/${specId}/confirm`);
    const claimed = await call("POST", "/worker/jobs/claim", {
      workerId: "w1",
      capabilities: [],
    });
    const job = claimed.body.job as { id: number; attempt: number };
    const bundle = await call(
      "GET",
      `/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
    );
    expect(bundle.body.domain).toBeNull();
  });
});
