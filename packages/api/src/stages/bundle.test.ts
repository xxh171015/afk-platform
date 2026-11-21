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
import type { Bundle, BundleRef } from "./bundle.ts";

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

const PIN = "0123456789abcdef0123456789abcdef01234567";
const PIN2 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Claimed {
  id: number;
  attempt: number;
  payload: { stage: string; ticketId?: number };
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

async function json(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function reportHosts() {
  await fetch(`${api.url}/worker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: "w1",
      hosts: [{ host: "github.com", kind: "github" }],
    }),
  });
}

async function runningSpecWithPayments(tickets: Record<string, unknown>[]) {
  await reportHosts();
  const project = await json("POST", "/projects", { name: "shop" });
  const projectId = (project.body as { id: number }).id;
  await json("POST", `/projects/${projectId}/repos`, {
    url: "git@github.com:acme/backend.git",
    name: "backend",
  });
  await json("POST", `/projects/${projectId}/repos`, {
    url: "git@github.com:acme/frontend.git",
    name: "frontend",
  });
  const spec = await json("POST", "/specs", {
    projectId,
    type: "feature",
    slug: "order-export",
    title: "Order export",
    body: "# spec body",
    refs: [
      { url: "https://github.com/acme/payments.git", defaultBranch: "main" },
    ],
  });
  expect(spec.status).toBe(201);
  const specId = (spec.body as { id: number }).id;
  const view = await json("GET", `/specs/${specId}`);
  const payments = (
    view.body as {
      spec: {
        refs: {
          repoId: number;
          name: string;
          url: string;
          sha: string | null;
        }[];
      };
    }
  ).spec.refs[0];
  expect(payments?.name).toBe("payments");
  expect(
    (
      await json(
        "POST",
        `/specs/${specId}/tickets/import`,
        importBody(specId, { tickets }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await json("POST", `/specs/${specId}/confirm`, {
        refPins: [{ repoId: payments.repoId, sha: PIN }],
      })
    ).status,
  ).toBe(200);
  return { specId, payments };
}

async function claim() {
  return (await worker.claim()).body.job as Claimed | null;
}

async function bundleOf(job: Claimed): Promise<Bundle> {
  const response = await fetch(
    `${api.url}/worker/jobs/${job.id}/bundle?workerId=w1&attempt=${job.attempt}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Bundle;
}

async function complete(job: Claimed, result: Record<string, unknown>) {
  const reply = await worker.complete(job.id, job.attempt, {
    stage: job.payload.stage,
    ...result,
  });
  expect(reply.status).toBe(200);
}

const TICKET_SUCCESS: Record<string, Record<string, unknown>> = {
  implement: { outcome: "done" },
  gate: { outcome: "passed" },
  review: { outcome: "pass" },
  merge: { outcome: "merged", headSha: "head" },
};

async function allTicketsDone() {
  for (let i = 0; i < 60; i++) {
    const open = await db.pool.query(
      "SELECT count(*) FROM tickets WHERE state NOT IN ('done', 'cancelled')",
    );
    if (Number(open.rows[0].count) === 0) return;
    const job = await claim();
    if (!job) throw new Error("ran out of jobs");
    await complete(job, TICKET_SUCCESS[job.payload.stage] ?? {});
  }
  throw new Error("tickets never finished");
}

const REVIEW_FIX = {
  outcome: "fix",
  run: {
    output: {
      verdict: "fix",
      mustFix: [
        { file: "src/a.ts", line: 3, problem: "a and b disagree on the name" },
      ],
      suggestions: [],
    },
  },
  findings: [
    { kind: "must-fix", body: "src/a.ts:3 a and b disagree on the name" },
  ],
};

function paymentsRef(refs: BundleRef[]) {
  return refs.find((ref) => ref.name === "payments");
}

describe("spec reference repos on the bundle", () => {
  it("puts the spec's pinned reference repo on implement and review bundles", async () => {
    await runningSpecWithPayments([ticket("a")]);
    const implement = await claim();
    expect(implement?.payload.stage).toBe("implement");
    const pinned = {
      name: "payments",
      url: "https://github.com/acme/payments.git",
      defaultBranch: "main",
      sha: PIN,
    };
    expect(paymentsRef((await bundleOf(implement as Claimed)).refs)).toEqual(
      pinned,
    );

    await complete(implement as Claimed, { outcome: "done" });
    const gate = await claim();
    expect(gate?.payload.stage).toBe("gate");
    await complete(gate as Claimed, { outcome: "passed" });
    const review = await claim();
    expect(review?.payload.stage).toBe("review");
    expect(paymentsRef((await bundleOf(review as Claimed)).refs)).toEqual(
      pinned,
    );
  });

  it("puts spec reference repos and this repo's ticket refs on final-review and final-fix bundles", async () => {
    await runningSpecWithPayments([ticket("a", { refs: ["frontend"] })]);
    await allTicketsDone();
    const review = await claim();
    expect(review?.payload.stage).toBe("final-review");
    const expected = [
      {
        name: "payments",
        url: "https://github.com/acme/payments.git",
        defaultBranch: "main",
        sha: PIN,
      },
      {
        name: "frontend",
        url: "git@github.com:acme/frontend.git",
        defaultBranch: "main",
        sha: null,
      },
    ];
    expect((await bundleOf(review as Claimed)).refs).toEqual(expected);

    await complete(review as Claimed, REVIEW_FIX);
    const fix = await claim();
    expect(fix?.payload.stage).toBe("final-fix");
    expect((await bundleOf(fix as Claimed)).refs).toEqual(expected);
  });

  it("keeps the pinned SHA when the reference repo's default branch moves, and uses the refreshed SHA after", async () => {
    const { specId, payments } = await runningSpecWithPayments([ticket("a")]);
    await db.pool.query("UPDATE repos SET default_sha = $2 WHERE id = $1", [
      payments.repoId,
      "ffffffffffffffffffffffffffffffffffffffff",
    ]);
    const implement = await claim();
    expect(implement?.payload.stage).toBe("implement");
    expect(paymentsRef((await bundleOf(implement as Claimed)).refs)?.sha).toBe(
      PIN,
    );

    expect(
      (
        await json("PUT", `/specs/${specId}/refs`, {
          refresh: [{ repoId: payments.repoId, sha: PIN2 }],
        })
      ).status,
    ).toBe(200);
    expect(paymentsRef((await bundleOf(implement as Claimed)).refs)?.sha).toBe(
      PIN2,
    );
  });

  it("lists a ticket ref that names a spec reference repo only once", async () => {
    await runningSpecWithPayments([ticket("a", { refs: ["payments"] })]);
    const implement = await claim();
    expect(implement?.payload.stage).toBe("implement");
    const refs = (await bundleOf(implement as Claimed)).refs;
    expect(refs.filter((ref) => ref.name === "payments")).toEqual([
      {
        name: "payments",
        url: "https://github.com/acme/payments.git",
        defaultBranch: "main",
        sha: PIN,
      },
    ]);
  });
});
