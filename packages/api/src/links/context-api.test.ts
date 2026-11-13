import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  api = await listen(testApp({ pool: db.pool }));
  worker = new FakeWorker(api.url, "w1", []);
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

const SECRET_DECISION = "SECRET_DECISION_TEXT";
const SECRET_SCOPE = "SECRET_SCOPE_TEXT";
const FILE_BODY = "FILE_BODY_SHOULD_NOT_APPEAR";
const ADR_PATH = "docs/adr/0001-pointers.md";
const PR_URL = "https://github.com/acme/backend/pull/12";
const REPO_URL = "https://github.com/acme/backend.git";
const REWRITTEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SPEC_BODY = `## Problem Statement

p

## Solution

s

## User Stories

n/a

## Implementation Decisions

Use the checkout-pointer protocol. ${SECRET_DECISION}

## Testing Decisions

Seam: the HTTP API.

## Out of Scope

Do not copy file bodies. ${SECRET_SCOPE}

## Further Notes

See ${ADR_PATH}
`;

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId?: number };
}

async function stage(expected: string, result: Record<string, unknown>) {
  const job = (await worker.claim()).body.job as Claimed | null;
  expect(job?.payload.stage).toBe(expected);
  const reply = await worker.complete(
    (job as Claimed).id,
    (job as Claimed).attempt,
    {
      stage: expected,
      ...result,
    },
  );
  expect(reply.status).toBe(200);
  return job as Claimed;
}

async function mergedSpecWithPr() {
  const created = await call("POST", "/projects", { name: "shop" });
  const repo = await call("POST", `/projects/${created.body.id}/repos`, {
    url: REPO_URL,
    name: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId: created.body.id,
    type: "feature",
    slug: "order-export",
    title: "Order export",
    body: SPEC_BODY,
  });
  const specId = spec.body.id as number;
  expect(
    (
      await call(
        "POST",
        `/specs/${specId}/tickets/import`,
        importBody(specId, {
          tickets: [
            {
              key: "a",
              repo: "backend",
              type: "implementation",
              title: "Ticket a",
              modules: ["src/a/**"],
              acceptance: ["it works"],
            },
          ],
        }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${specId}/confirm`)).status).toBe(200);

  await stage("implement", {
    outcome: "done",
    run: { commits: [REWRITTEN] },
  });
  await stage("gate", { outcome: "passed" });
  await stage("review", { outcome: "pass" });
  await stage("merge", { outcome: "merged", headSha: "integration-head" });

  await db.pool.query(
    `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha)
     VALUES ($1, $2, 12, $3, 'open', 'head')`,
    [specId, repo.body.id, PR_URL],
  );

  return { specId, repoId: repo.body.id as number };
}

describe("POST /context", () => {
  it("returns spec, ticket, pull request, decision and ADR pointers for a blamed commit, without copying spec or file bodies", async () => {
    const { specId } = await mergedSpecWithPr();

    const reply = await call("POST", "/context", {
      repoUrl: REPO_URL,
      files: [
        {
          path: "src/orders.ts",
          commits: [{ sha: REWRITTEN }],
        },
      ],
    });

    expect(reply.status).toBe(200);
    expect(reply.body.files).toEqual([
      {
        path: "src/orders.ts",
        specs: [{ id: specId, displayId: `S-${specId}` }],
        tickets: [{ id: 1, displayId: "T-1" }],
        pullRequests: [{ number: 12, url: PR_URL }],
        decisions: [
          {
            specDisplayId: `S-${specId}`,
            heading: "Implementation Decisions",
          },
        ],
        outOfScope: [{ specDisplayId: `S-${specId}`, heading: "Out of Scope" }],
        adrs: [{ path: ADR_PATH }],
      },
    ]);

    const dumped = JSON.stringify(reply.body);
    expect(dumped).not.toContain(SECRET_DECISION);
    expect(dumped).not.toContain(SECRET_SCOPE);
    expect(dumped).not.toContain(FILE_BODY);
    expect(dumped).not.toContain("Use the checkout-pointer protocol");
  });

  it("fills spec and ticket from commit trailers when there is no Link for the SHA", async () => {
    const created = await call("POST", "/projects", { name: "shop" });
    await call("POST", `/projects/${created.body.id}/repos`, {
      url: REPO_URL,
      name: "backend",
    });
    const spec = await call("POST", "/specs", {
      projectId: created.body.id,
      type: "feature",
      slug: "order-export",
      title: "Order export",
      body: SPEC_BODY,
    });
    const specId = spec.body.id as number;
    expect(
      (
        await call(
          "POST",
          `/specs/${specId}/tickets/import`,
          importBody(specId, {
            tickets: [
              {
                key: "a",
                repo: "backend",
                type: "implementation",
                title: "Ticket a",
                modules: ["src/a/**"],
                acceptance: ["it works"],
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);

    const unknownSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const reply = await call("POST", "/context", {
      repo: "backend",
      files: [
        {
          path: "src/orders.ts",
          commits: [{ sha: unknownSha, spec: `S-${specId}`, ticket: "T-1" }],
        },
      ],
    });

    expect(reply.status).toBe(200);
    expect(reply.body.files[0].specs).toEqual([
      { id: specId, displayId: `S-${specId}` },
    ]);
    expect(reply.body.files[0].tickets).toEqual([{ id: 1, displayId: "T-1" }]);
    expect(JSON.stringify(reply.body)).not.toContain(SECRET_DECISION);
  });

  it("says when the clone URL is not a registered repo", async () => {
    await call("POST", "/projects", { name: "shop" });
    await call("POST", "/projects/1/repos", {
      url: REPO_URL,
      name: "backend",
    });
    const reply = await call("POST", "/context", {
      repoUrl: "https://github.com/other/other.git",
      files: [],
    });
    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe("no registered repo matches");
  });
});
