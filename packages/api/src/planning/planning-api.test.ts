import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi } from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

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

// Just the reply fields these tests read; the real shapes are in the generated client.
interface Reply {
  id: number;
  name?: string;
  displayId?: string;
  tickets: { key: string; id: number; displayId: string }[];
  warnings: { type: string; tickets: string[] }[];
  errors: string[];
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply };
}

async function patch(path: string, body: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply };
}

async function setup(contractPath: string | null = "openapi.yaml") {
  const project = await post("/projects", { name: "shop" });
  const projectId = project.body.id as number;
  await post(`/projects/${projectId}/repos`, {
    url: "git@github.com:acme/backend.git",
    name: "backend",
  });
  await post(`/projects/${projectId}/repos`, {
    url: "git@github.com:acme/frontend.git",
    name: "frontend",
    defaultBranch: "develop",
  });
  if (contractPath) {
    await patch(`/projects/${projectId}/repos/backend`, { contractPath });
  }
  const spec = await post("/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
  });
  return { projectId, specId: spec.body.id as number };
}

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "backend",
  type: "implementation",
  title: `Ticket ${key}`,
  modules: [`src/${key}/**`],
  acceptance: ["it works"],
  ...extra,
});

const count = async (table: string) =>
  Number((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe("projects, repos and specs", () => {
  it("creates a project with defaults and a repo with the default branch main", async () => {
    const project = await post("/projects", {
      name: "shop",
      protectedPaths: ["openapi/**"],
      maxConcurrency: 2,
    });
    expect(project).toMatchObject({ status: 201, body: { name: "shop" } });
    const repo = await post(`/projects/${project.body.id}/repos`, {
      url: "git@github.com:acme/backend.git",
      name: "backend",
    });
    expect(repo).toMatchObject({ status: 201, body: { name: "backend" } });
    const rows = await db.pool.query(
      "SELECT p.protected_paths, p.max_concurrency, r.default_branch FROM projects p JOIN repos r ON r.project_id = p.id",
    );
    expect(rows.rows[0]).toEqual({
      protected_paths: ["openapi/**"],
      max_concurrency: 2,
      default_branch: "main",
    });
  });

  it("rejects a repo for an unknown project and a second repo with the same name", async () => {
    expect(
      (await post("/projects/99/repos", { url: "u", name: "backend" })).status,
    ).toBe(404);
    const { projectId } = await setup();
    const again = await post(`/projects/${projectId}/repos`, {
      url: "other",
      name: "backend",
    });
    expect(again.status).toBe(409);
  });

  it("still takes role as another word for name, and answers with the name", async () => {
    const { projectId } = await setup();
    const repo = await post(`/projects/${projectId}/repos`, {
      url: "git@github.com:acme/worker.git",
      role: "worker",
    });
    expect(repo).toMatchObject({ status: 201, body: { name: "worker" } });
    expect(
      (await post(`/projects/${projectId}/repos`, { url: "u" })).status,
    ).toBe(400);
    expect(
      (
        await post(`/projects/${projectId}/repos`, {
          url: "u",
          name: "a",
          role: "b",
        })
      ).status,
    ).toBe(400);
  });

  it("creates a spec and returns its display id; a slug is unique within the project", async () => {
    const { projectId, specId } = await setup();
    expect(specId).toBe(1);
    const spec = await post("/specs", {
      projectId,
      type: "improvement",
      slug: "second",
      title: "Second",
    });
    expect(spec).toMatchObject({ status: 201, body: { displayId: "S-2" } });
    const dup = await post("/specs", {
      projectId,
      type: "feature",
      slug: "second",
      title: "x",
    });
    expect(dup.status).toBe(409);
    const orphan = await post("/specs", {
      projectId: 99,
      type: "feature",
      slug: "a",
      title: "x",
    });
    expect(orphan.status).toBe(404);
  });

  it("validates request bodies", async () => {
    expect((await post("/projects", { name: "" })).status).toBe(400);
    const { projectId } = await setup();
    const badSlug = await post("/specs", {
      projectId,
      type: "feature",
      slug: "Not A Slug",
      title: "x",
    });
    expect(badSlug.status).toBe(400);
  });
});

describe("tickets import", () => {
  const exportFile = (extra: Record<string, unknown> = {}) => ({
    tickets: [
      ticket("contract", {
        type: "contract",
        protected_paths_ok: ["openapi/openapi.yaml"],
      }),
      ticket("be", { blocked_by: ["contract"] }),
      ticket("fe", { repo: "frontend", contract: "contract" }),
    ],
    ...extra,
  });

  it("refuses a contract edge when the upstream's repo has no contract path, and names the repo and the command", async () => {
    const { specId } = await setup(null);
    const result = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, exportFile({ spec: `S-${specId}` })),
    );
    expect(result.status).toBe(422);
    expect(result.body.errors.join("\n")).toMatch(/repo backend/);
    expect(result.body.errors.join("\n")).toMatch(
      /plat repo edit backend --project <id> --contract-path/,
    );
  });

  it("writes every ticket and edge, returns display ids, and stores no warnings when there are none", async () => {
    const { specId } = await setup();
    const result = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, exportFile({ spec: `S-${specId}` })),
    );
    expect(result.status).toBe(200);
    expect(result.body.tickets).toEqual([
      { key: "contract", id: 1, displayId: "T-1" },
      { key: "be", id: 2, displayId: "T-2" },
      { key: "fe", id: 3, displayId: "T-3" },
    ]);
    expect(result.body.warnings).toEqual([]);
    const tickets = await db.pool.query(
      "SELECT t.type, t.state, t.allowed_protected_paths, r.name FROM tickets t JOIN repos r ON r.id = t.repo_id ORDER BY t.id",
    );
    expect(tickets.rows).toEqual([
      {
        type: "contract",
        state: "pending",
        allowed_protected_paths: ["openapi/openapi.yaml"],
        name: "backend",
      },
      {
        type: "implementation",
        state: "pending",
        allowed_protected_paths: [],
        name: "backend",
      },
      {
        type: "implementation",
        state: "pending",
        allowed_protected_paths: [],
        name: "frontend",
      },
    ]);
    const edges = await db.pool.query(
      "SELECT from_ticket_id, to_ticket_id, kind FROM edges ORDER BY id",
    );
    expect(edges.rows).toEqual([
      { from_ticket_id: 1, to_ticket_id: 2, kind: "blocks" },
      { from_ticket_id: 1, to_ticket_id: 3, kind: "contract" },
    ]);
  });

  it("saves module overlap warnings with the spec and still imports", async () => {
    const { specId } = await setup();
    const result = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, {
        tickets: [
          ticket("a", { modules: ["src/orders/**"] }),
          ticket("b", { modules: ["src/orders/export.ts"] }),
        ],
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.warnings).toHaveLength(1);
    expect(result.body.warnings[0]).toMatchObject({
      type: "module-overlap",
      tickets: ["a", "b"],
    });
    const stored = await db.pool.query(
      "SELECT import_warnings FROM specs WHERE id = $1",
      [specId],
    );
    expect(stored.rows[0].import_warnings).toEqual(result.body.warnings);
    expect(await count("tickets")).toBe(2);
  });

  const rejected: [string, (specId: number) => unknown, RegExp][] = [
    [
      "a dependency cycle",
      () => ({
        tickets: [
          ticket("a", { blocked_by: ["b"] }),
          ticket("b", { blocked_by: ["a"] }),
        ],
      }),
      /cycle/,
    ],
    [
      "a repo outside the project",
      () => ({ tickets: [ticket("a", { repo: "mobile" })] }),
      /mobile/,
    ],
    [
      "a ticket without acceptance criteria",
      () => ({ tickets: [ticket("a", { acceptance: [] })] }),
      /Acceptance criteria/,
    ],
    [
      "a ticket with no module glob",
      () => ({ tickets: [ticket("a", { modules: [] })] }),
      /modules/,
    ],
    [
      "a contract edge from a non-contract ticket",
      () => ({ tickets: [ticket("a"), ticket("b", { contract: "a" })] }),
      /contract ticket/,
    ],
  ];
  it.each(rejected)(
    "rejects the whole file for %s and writes nothing",
    async (_name, build, message) => {
      const { specId } = await setup();
      const result = await post(
        `/specs/${specId}/tickets/import`,
        importBody(specId, build(specId) as never),
      );
      expect(result.status).toBe(422);
      expect(result.body.errors.join("\n")).toMatch(message);
      expect(await count("tickets")).toBe(0);
      expect(await count("edges")).toBe(0);
      const stored = await db.pool.query(
        "SELECT import_warnings FROM specs WHERE id = $1",
        [specId],
      );
      expect(stored.rows[0].import_warnings).toEqual([]);
    },
  );

  it("rejects a file with one bad ticket among good ones without importing the good ones", async () => {
    const { specId } = await setup();
    const result = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, {
        tickets: [ticket("good"), ticket("bad", { acceptance: [] })],
      }),
    );
    expect(result.status).toBe(422);
    expect(await count("tickets")).toBe(0);
  });

  describe("ticket files as written", () => {
    const front = `---
title: 导出按钮
repo: backend
type: implementation
modules: ["src/orders/**"]
---
`;
    const body = (specId: number, extra = "") =>
      [
        "## Parent",
        "",
        `S-${specId}`,
        "",
        "## What to build",
        "",
        "导出订单为 CSV。  ",
        "",
        "```md",
        "## Blocked by",
        "```",
        "",
        "| 列 | 说明 |",
        "| --- | --- |",
        "| id | 订单号 |",
        "",
        "- 外层",
        "  - 内层",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] 下载的文件有表头",
        "- [ ] 中文 `代码`",
        extra,
      ].join("\n");

    it("stores the body as written, apart from CRLF and the blank lines at the end, and reads the acceptance criteria out of it", async () => {
      const { specId } = await setup();
      const text = `${front}${body(specId)}\n\n\n`;
      const result = await post(`/specs/${specId}/tickets/import`, {
        files: [{ name: "01-export.md", text: text.replace(/\n/g, "\r\n") }],
      });
      expect(result.status).toBe(200);
      const stored = await db.pool.query(
        "SELECT body, acceptance_criteria FROM tickets",
      );
      expect(stored.rows).toEqual([
        {
          body: body(specId),
          acceptance_criteria: ["下载的文件有表头", "中文 `代码`"],
        },
      ]);
    });

    it("refuses a Parent that is another spec and a Blocked by section, naming the file and the line, and writes nothing", async () => {
      const { specId } = await setup();
      const result = await post(`/specs/${specId}/tickets/import`, {
        files: [
          {
            name: "01-a.md",
            text: front + body(specId + 1),
          },
          {
            name: "02-b.md",
            text: `${front}${body(specId, "\n## Blocked by\n\n- #3\n")}`,
          },
        ],
      });
      expect(result.status).toBe(422);
      expect(result.body.errors).toEqual([
        expect.stringMatching(
          new RegExp(`^01-a\\.md:\\d+: .*must be S-${specId}`),
        ),
        expect.stringMatching(/^02-b\.md:\d+: .*Blocked by.*is not allowed/),
      ]);
      expect(await count("tickets")).toBe(0);
    });

    it("lists the problems of the files and of the graph of the readable ones together, and writes nothing", async () => {
      const { specId } = await setup();
      const { files } = importBody(specId, {
        tickets: [
          ticket("a", { blocked_by: ["b"] }),
          ticket("b", { blocked_by: ["a"] }),
        ],
      });
      const result = await post(`/specs/${specId}/tickets/import`, {
        files: [...files, { name: "03-broken.md", text: "no front matter" }],
      });
      expect(result.status).toBe(422);
      expect(result.body.errors).toEqual([
        expect.stringMatching(/^03-broken\.md: the file must start/),
        expect.stringMatching(/cycle/),
      ]);
      expect(await count("tickets")).toBe(0);
    });

    it("says tickets.yaml is no longer accepted", async () => {
      const { specId } = await setup();
      const result = await post(`/specs/${specId}/tickets/import`, {
        files: [{ name: "tickets.yaml", text: "tickets: []" }],
      });
      expect(result.status).toBe(422);
      expect(result.body.errors).toEqual([
        expect.stringContaining("tickets.yaml is no longer accepted"),
      ]);
    });
  });

  it("is all at once: a second import into the same spec is refused", async () => {
    const { specId } = await setup();
    expect(
      (
        await post(
          `/specs/${specId}/tickets/import`,
          importBody(specId, exportFile()),
        )
      ).status,
    ).toBe(200);
    const again = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, {
        tickets: [ticket("x")],
      }),
    );
    expect(again.status).toBe(409);
    expect(await count("tickets")).toBe(3);
  });

  it("refuses a spec that is no longer a draft, and an unknown spec", async () => {
    const { specId } = await setup();
    await db.pool.query("UPDATE specs SET state = 'planned' WHERE id = $1", [
      specId,
    ]);
    expect(
      (
        await post(
          `/specs/${specId}/tickets/import`,
          importBody(specId, exportFile()),
        )
      ).status,
    ).toBe(409);
    expect(
      (await post("/specs/999/tickets/import", importBody(999, exportFile())))
        .status,
    ).toBe(404);
  });

  it("lets only one of two concurrent imports win", async () => {
    const { specId } = await setup();
    const results = await Promise.all([
      post(`/specs/${specId}/tickets/import`, importBody(specId, exportFile())),
      post(`/specs/${specId}/tickets/import`, importBody(specId, exportFile())),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count("tickets")).toBe(3);
  });
});

describe("project view", () => {
  it("lists the project's repos in the order they were added, with the contract path of the one that has it", async () => {
    const { projectId } = await setup();
    const response = await fetch(`${api.url}/projects/${projectId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: projectId,
      name: "shop",
      repos: [
        {
          name: "backend",
          url: "git@github.com:acme/backend.git",
          defaultBranch: "main",
          contractPath: "openapi.yaml",
          hostKind: "github",
        },
        {
          name: "frontend",
          url: "git@github.com:acme/frontend.git",
          defaultBranch: "develop",
          contractPath: null,
          hostKind: "github",
        },
      ],
    });
  });

  const hostKinds = async (projectId: number) =>
    (
      (await (await fetch(`${api.url}/projects/${projectId}`)).json()) as {
        repos: { name: string; hostKind: string }[];
      }
    ).repos.map((r) => `${r.name}:${r.hostKind}`);

  it("registers the host kind a repo is given, and works it out from the address when none is given", async () => {
    const project = await post("/projects", { name: "shop" });
    const id = project.body.id as number;
    await post(`/projects/${id}/repos`, {
      url: "https://gitlab.com/acme/api.git",
      name: "api",
    });
    await post(`/projects/${id}/repos`, {
      url: "https://git.example.org/acme/web.git",
      name: "web",
      hostKind: "gitlab",
    });
    expect(await hostKinds(id)).toEqual(["api:gitlab", "web:gitlab"]);
    // no worker named git.example.org and the address does not say: GitHub, in a project of its own
    const other = (await post("/projects", { name: "other" })).body
      .id as number;
    await post(`/projects/${other}/repos`, {
      url: "https://git.example.org/acme/app.git",
      name: "app",
    });
    expect(await hostKinds(other)).toEqual(["app:github"]);
  });

  it("changes a repo's host kind, and refuses a kind that does not exist", async () => {
    const project = await post("/projects", { name: "shop" });
    const id = project.body.id as number;
    await post(`/projects/${id}/repos`, {
      url: "https://git.example.org/acme/web.git",
      name: "web",
    });
    expect(
      (await patch(`/projects/${id}/repos/web`, { hostKind: "gitlab" })).status,
    ).toBe(200);
    expect(await hostKinds(id)).toEqual(["web:gitlab"]);
    expect(
      (await patch(`/projects/${id}/repos/web`, { hostKind: "gitea" })).status,
    ).toBe(400);
    expect(
      (
        await post(`/projects/${id}/repos`, {
          url: "https://git.example.org/acme/x.git",
          name: "x",
          hostKind: "gitea",
        })
      ).status,
    ).toBe(400);
    expect(await hostKinds(id)).toEqual(["web:gitlab"]);
  });

  it("says plainly when the project does not exist", async () => {
    const response = await fetch(`${api.url}/projects/99`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such project" });
  });
});

describe("project edit", () => {
  const projectRow = async () =>
    (await db.pool.query("SELECT * FROM projects WHERE id = 1")).rows[0];

  it("changes only the fields that are sent", async () => {
    await post("/projects", {
      name: "shop",
      protectedPaths: [".github/**"],
      maxConcurrency: 2,
      budgetLimit: 100,
      limits: { repoConcurrency: 3 },
    });
    const result = await patch("/projects/1", { budgetLimit: 50 });
    expect(result.status).toBe(200);
    expect(await projectRow()).toMatchObject({
      name: "shop",
      budget_limit: 50,
      protected_paths: [".github/**"],
      max_concurrency: 2,
      limits: { repoConcurrency: 3 },
    });
  });

  it("changes the default model", async () => {
    await post("/projects", { name: "shop", defaultModel: "old-model" });
    expect(
      (await patch("/projects/1", { defaultModel: "composer-2" })).status,
    ).toBe(200);
    expect((await projectRow()).default_model).toBe("composer-2");
    expect((await patch("/projects/1", { defaultModel: "" })).status).toBe(400);
  });

  it("replaces the protected paths as a whole and merges limits over the stored ones", async () => {
    await post("/projects", {
      name: "shop",
      protectedPaths: [".github/**", "openapi/**"],
      limits: { repoConcurrency: 3, specAgentSeconds: 60 },
    });
    await patch("/projects/1", {
      protectedPaths: ["infra/**"],
      limits: { repoConcurrency: 4 },
    });
    expect(await projectRow()).toMatchObject({
      protected_paths: ["infra/**"],
      limits: { repoConcurrency: 4, specAgentSeconds: 60 },
    });
    await patch("/projects/1", { protectedPaths: [] });
    expect((await projectRow()).protected_paths).toEqual([]);
  });

  it("says plainly when the project does not exist, even for an empty edit", async () => {
    const result = await patch("/projects/99", { maxConcurrency: 2 });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "no such project" });
    expect((await patch("/projects/99", {})).status).toBe(404);
  });

  it("validates like project create and changes nothing when it refuses", async () => {
    await post("/projects", { name: "shop", budgetLimit: 7 });
    for (const body of [
      { contractPath: "openapi.yaml" },
      { limits: { nope: 1 } },
      { limits: { repoConcurrency: 0 } },
      { maxConcurrency: 0 },
      { budgetLimit: -1 },
      { protectedPaths: [""] },
    ]) {
      expect((await patch("/projects/1", body)).status).toBe(400);
    }
    expect((await projectRow()).budget_limit).toBe(7);
    const moved = await post("/projects", {
      name: "x",
      contractPath: "openapi.yaml",
    });
    expect(moved.status).toBe(400);
  });

  it("lets a repo without a contract path serve a contract edge once it has one", async () => {
    const { projectId, specId } = await setup(null);
    const file = {
      spec: `S-${specId}`,
      tickets: [
        ticket("contract", {
          type: "contract",
          protected_paths_ok: ["openapi/openapi.yaml"],
        }),
        ticket("fe", { repo: "frontend", contract: "contract" }),
      ],
    };
    expect(
      (await post(`/specs/${specId}/tickets/import`, importBody(specId, file)))
        .status,
    ).toBe(422);
    expect(
      (
        await patch(`/projects/${projectId}/repos/backend`, {
          contractPath: "openapi/openapi.yaml",
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(`/specs/${specId}/tickets/import`, importBody(specId, file)))
        .status,
    ).toBe(200);
  });
});

describe("tickets across repos", () => {
  it("stores refs and environment, and reads them back in the ticket and spec views", async () => {
    const { specId } = await setup();
    const result = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, {
        tickets: [
          ticket("fe", { repo: "frontend", refs: ["backend"] }),
          ticket("e2e", {
            repo: "frontend",
            type: "integration",
            environment: ["backend"],
            blocked_by: ["fe"],
          }),
        ],
      }),
    );
    expect(result.status).toBe(200);
    const view = await (await fetch(`${api.url}/tickets/2`)).json();
    expect(view.ticket).toMatchObject({
      repo: "frontend",
      refs: [],
      environment: ["backend"],
    });
    const spec = await (await fetch(`${api.url}/specs/${specId}`)).json();
    expect(spec.tickets.map((t: { refs: string[] }) => t.refs)).toEqual([
      ["backend"],
      [],
    ]);
  });

  it("refuses names outside the project, an environment on a plain ticket and a repo ring, writing nothing", async () => {
    const { projectId, specId } = await setup();
    await post(`/projects/${projectId}/repos`, { url: "u", name: "payments" });
    await patch(`/projects/${projectId}/repos/frontend`, {
      contractPath: "fe.yaml",
    });
    await patch(`/projects/${projectId}/repos/payments`, {
      contractPath: "pay.yaml",
    });
    const bad = await post(
      `/specs/${specId}/tickets/import`,
      importBody(specId, {
        tickets: [
          ticket("a", { refs: ["nope"] }),
          ticket("b", { environment: ["frontend"] }),
          ticket("cb", { type: "contract" }),
          ticket("cf", { type: "contract", repo: "frontend" }),
          ticket("cp", { type: "contract", repo: "payments" }),
          ticket("p", { repo: "payments", contract: "cb" }),
          ticket("be", { repo: "backend", contract: "cf" }),
          ticket("f", { repo: "frontend", contract: "cp" }),
        ],
      }),
    );
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([
      expect.stringMatching(/ticket a: refs nope/),
      expect.stringMatching(/ticket b: environment .*integration/),
      expect.stringMatching(/repo contract cycle/),
    ]);
    expect(await count("tickets")).toBe(0);
  });
});

describe("appending tickets to a confirmed spec", () => {
  const exportFile = {
    tickets: [
      ticket("contract", { type: "contract" }),
      ticket("be", { blocked_by: ["contract"] }),
      ticket("fe", { repo: "frontend", contract: "contract" }),
    ],
  };

  async function confirmed() {
    const { projectId, specId } = await setup();
    await post(`/projects/${projectId}/repos`, { url: "u", name: "payments" });
    expect(
      (
        await post(
          `/specs/${specId}/tickets/import`,
          importBody(specId, exportFile),
        )
      ).status,
    ).toBe(200);
    expect((await post(`/specs/${specId}/confirm`, {})).status).toBe(200);
    return { projectId, specId };
  }
  const append = (specId: number, body: unknown) =>
    post(
      `/specs/${specId}/tickets/import?append=true`,
      importBody(specId, body as never),
    );
  const states = async () =>
    (await db.pool.query("SELECT id, state, appended FROM tickets ORDER BY id"))
      .rows;

  it("adds the tickets and edges at once, and the scheduler starts a new ticket that nothing blocks", async () => {
    const { specId } = await confirmed();
    expect((await states())[0]).toMatchObject({ state: "queued" });

    const result = await append(specId, {
      tickets: [
        ticket("extra", { repo: "payments", modules: ["pay/**"] }),
        ticket("after", { blocked_by: ["T-1", "extra"] }),
      ],
    });

    expect(result.status).toBe(200);
    expect(result.body.tickets).toEqual([
      { key: "extra", id: 4, displayId: "T-4" },
      { key: "after", id: 5, displayId: "T-5" },
    ]);
    expect(await states()).toEqual([
      { id: 1, state: "queued", appended: false },
      { id: 2, state: "pending", appended: false },
      { id: 3, state: "pending", appended: false },
      { id: 4, state: "queued", appended: true },
      { id: 5, state: "pending", appended: true },
    ]);
    const edges = await db.pool.query(
      "SELECT from_ticket_id AS f, to_ticket_id AS t, kind FROM edges WHERE to_ticket_id = 5 ORDER BY id",
    );
    expect(edges.rows).toEqual([
      { f: 1, t: 5, kind: "blocks" },
      { f: 4, t: 5, kind: "blocks" },
    ]);
    // payments had no ticket yet: it now has its integration branch, and the job can be built
    const branches = await db.pool.query(
      "SELECT integration_branches FROM specs WHERE id = $1",
      [specId],
    );
    expect(branches.rows[0].integration_branches).toHaveLength(3);
    const view = await (await fetch(`${api.url}/specs/${specId}`)).json();
    expect(view.tickets.map((t: { appended: boolean }) => t.appended)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("refuses a draft (use the plain import) and a spec that has gone on to its review, writing nothing", async () => {
    const { specId: draftId } = await setup();
    const draft = await append(draftId, { tickets: [ticket("a")] });
    expect(draft.status).toBe(409);
    expect(JSON.stringify(draft.body)).toMatch(/without --append/);

    const { specId } = await confirmed();
    await db.pool.query("UPDATE specs SET state = 'finalizing' WHERE id = $1", [
      specId,
    ]);
    const late = await append(specId, { tickets: [ticket("a")] });
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toMatch(/finalizing/);
    expect(await count("tickets")).toBe(3);
  });

  it("refuses a ticket that blocks a running ticket, and a cycle, and writes nothing", async () => {
    const { specId } = await confirmed();
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 1");
    const cases: [unknown, RegExp][] = [
      [
        { tickets: [ticket("a")], edges: [{ from: "a", to: "T-1" }] },
        /T-1 is running/,
      ],
      [
        {
          tickets: [ticket("a", { blocked_by: ["T-2"] })],
          edges: [{ from: "a", to: "T-2" }],
        },
        /cycle/,
      ],
    ];
    for (const [body, pattern] of cases) {
      const result = await append(specId, body);
      expect(result.status).toBe(422);
      expect(result.body.errors.join("\n")).toMatch(pattern);
    }
    expect(await count("tickets")).toBe(3);
    expect(await count("edges")).toBe(2);
  });

  it("applies the import rules to the merged graph: a contract upstream must be a contract ticket, and two in one repo must chain", async () => {
    const { specId } = await confirmed();
    const notContract = await append(specId, {
      tickets: [ticket("a", { contract: ["T-2"] })],
    });
    expect(notContract.body.errors.join("\n")).toMatch(/not a contract ticket/);
    const apart = await append(specId, {
      tickets: [
        ticket("c2", { type: "contract" }),
        ticket("fe2", { repo: "frontend", contract: ["T-1", "c2"] }),
      ],
    });
    expect(apart.body.errors.join("\n")).toMatch(/chain/);
    expect(await count("tickets")).toBe(3);
  });

  it("warns about tickets on the old contract only when a contract ticket is appended, by the state of those tickets", async () => {
    const { specId } = await confirmed();
    await db.pool.query("UPDATE tickets SET state = 'running' WHERE id = 3");
    await db.pool.query("UPDATE tickets SET state = 'done' WHERE id = 1");
    const plain = await append(specId, {
      tickets: [ticket("plain", { repo: "payments", modules: ["p/**"] })],
    });
    expect(plain.body.warnings).toEqual([]);

    const result = await append(specId, {
      tickets: [
        ticket("c2", {
          type: "contract",
          blocked_by: ["T-1"],
          modules: ["api2/**"],
        }),
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body.warnings).toEqual([
      expect.objectContaining({
        type: "old-contract-started",
        tickets: ["T-3", "T-5"],
        message: expect.stringMatching(/T-3 is running.*old contract T-1.*T-5/),
      }),
    ]);
    const stored = await db.pool.query(
      "SELECT import_warnings FROM specs WHERE id = $1",
      [specId],
    );
    expect(stored.rows[0].import_warnings).toHaveLength(1);
  });

  it("leaves a ticket that reported contract-change-needed blocked when a new ticket is made to block it", async () => {
    const { specId } = await confirmed();
    await db.pool.query(
      "UPDATE tickets SET state = 'blocked', blocked_reason = 'contract-change-needed' WHERE id = 3",
    );
    const result = await append(specId, {
      tickets: [
        ticket("c2", {
          type: "contract",
          blocked_by: ["T-1"],
          modules: ["api2/**"],
        }),
      ],
      edges: [{ from: "c2", to: "T-3" }],
    });
    expect(result.status).toBe(200);
    expect((await states())[2]).toMatchObject({ id: 3, state: "blocked" });
    const reason = await db.pool.query(
      "SELECT blocked_reason FROM tickets WHERE id = 3",
    );
    expect(reason.rows[0].blocked_reason).toBe("contract-change-needed");
  });

  it("splits a ticket by appending new ones and cancelling the old: a cancelled ticket is no longer a valid end", async () => {
    const { specId } = await confirmed();
    await db.pool.query("UPDATE tickets SET state = 'cancelled' WHERE id = 3");
    const result = await append(specId, {
      tickets: [ticket("half", { repo: "frontend", blocked_by: ["T-3"] })],
    });
    expect(result.status).toBe(422);
    expect(result.body.errors.join("\n")).toMatch(/T-3 is cancelled/);
  });
});

describe("repo edit", () => {
  const contractPaths = async () =>
    (await db.pool.query("SELECT name, contract_path FROM repos ORDER BY id"))
      .rows;

  it("sets, changes and clears the contract path of one repo", async () => {
    const { projectId } = await setup(null);
    const url = `/projects/${projectId}/repos/backend`;
    expect(
      await patch(url, { contractPath: "openapi/openapi.yaml" }),
    ).toMatchObject({ status: 200, body: { name: "backend" } });
    expect(await contractPaths()).toEqual([
      { name: "backend", contract_path: "openapi/openapi.yaml" },
      { name: "frontend", contract_path: null },
    ]);
    await patch(url, { contractPath: "api.yaml" });
    expect((await contractPaths())[0]?.contract_path).toBe("api.yaml");
    await patch(url, { contractPath: "" });
    expect((await contractPaths())[0]?.contract_path).toBeNull();
  });

  it("says plainly when the project or the repo does not exist, and refuses a path that is not a path", async () => {
    const { projectId } = await setup(null);
    expect(
      (await patch("/projects/99/repos/backend", { contractPath: "a" })).status,
    ).toBe(404);
    const missing = await patch(`/projects/${projectId}/repos/nope`, {
      contractPath: "a",
    });
    expect(missing).toMatchObject({
      status: 404,
      body: { error: "no such repo" },
    });
    for (const contractPath of ["backend:openapi.yaml", "/abs.yaml", " "]) {
      expect(
        (await patch(`/projects/${projectId}/repos/backend`, { contractPath }))
          .status,
      ).toBe(400);
    }
  });
});
