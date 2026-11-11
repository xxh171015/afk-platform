import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions, AgentRunResult } from "@afk/pipeline";
import { git } from "@afk/pipeline";
import {
  FakeAgentRunner,
  FakeGateSandbox,
  makeRepo,
  type TestRepo,
} from "@afk/pipeline/testing";
import {
  createWorkerApi,
  type ExecutorDeps,
  pushRef,
  RepoStore,
  runWorker,
  SlotManager,
  SnapshotStore,
} from "@afk/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import {
  FakeClock,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";

// Locate: a real Postgres, the HTTP API, real git, slots and snapshots, and a
// worker with a fake agent. No compose. The original spec comes from blame.

const ID = "abc123";
const REPORT =
  "TypeError: Cannot read properties of undefined (reading 'id')\nat exportOrders (src/orders.ts:12)";

let db: TestDatabase;
let api: RunningApi;
let home: string;
let backendSeed: TestRepo;
let frontendSeed: TestRepo;
let agentRuns: {
  stage: string;
  prompt: string;
  placement: unknown;
  refs: string[];
  specMd: string | undefined;
}[];
const origins: Record<string, string> = {};

const bareOf = (name: string, seed: TestRepo) => {
  const dir = join(home, `${name}.git`);
  git(home, ["clone", "--quiet", "--bare", seed.dir, dir]);
  origins[name] = dir;
};

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  await db.pool.query("UPDATE instance SET id = $1", [ID]);
  api = await listen(testApp({ pool: db.pool, clock: new FakeClock().now }));
  home = mkdtempSync(join(tmpdir(), "afk-locate-home-"));
  backendSeed = makeRepo({ "README.md": "# backend\n" });
  backendSeed.commit(
    {
      "src/orders.ts":
        "export function exportOrders() { throw new TypeError('id') }\n",
    },
    "export orders\n\nSpec: S-1\nTicket: T-1\n",
  );
  frontendSeed = makeRepo({ "README.md": "# frontend\n" });
  bareOf("backend", backendSeed);
  bareOf("frontend", frontendSeed);
  agentRuns = [];
});
afterEach(async () => {
  await api.close();
  await db.drop();
  backendSeed.cleanup();
  frontendSeed.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { id: number; displayId?: string },
  };
}

class RecordingAgentRunner extends FakeAgentRunner {
  override async run<Schema extends z.ZodType>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentRunResult<z.infer<Schema>>> {
    agentRuns.push({
      stage: options.stage,
      prompt: readFileSync(options.promptFile, "utf8"),
      placement: options.placement,
      refs: (options.refs ?? []).map((ref) => ref.name),
      specMd: options.ctxDir
        ? readFileSync(join(options.ctxDir, "spec.md"), "utf8")
        : undefined,
    });
    return super.run(options);
  }
}

function executor(): Omit<ExecutorDeps, "api"> {
  const repos = new RepoStore(join(home, "repos"));
  return {
    slots: new SlotManager({
      root: join(home, "slots"),
      count: 2,
      mainCloneFor: (repo, url) => repos.dirFor(repo, url),
      salvageDir: join(home, "salvage"),
      isHeld: async () => true,
    }),
    repos,
    snapshots: new SnapshotStore(join(home, "snapshots")),
    push: (request) => pushRef(request),
    makeAgentRunner: (slotDir) =>
      new RecordingAgentRunner(slotDir, async (ctx) => {
        if (ctx.stage !== "locate-bug") {
          throw new Error(`unexpected stage ${ctx.stage}`);
        }
        return {
          output: {
            result: "found",
            repo: "backend",
            files: ["src/orders.ts"],
            evidence: "the stack names exportOrders",
            reproduction: "POST /orders/export",
          },
        };
      }),
    makeGateSandbox: (slotDir) => new FakeGateSandbox(slotDir),
  };
}

describe("locate with a fake agent", { timeout: 60_000 }, () => {
  it("checkouts every default branch, blames the named repo, and fills the original spec", async () => {
    const created = await post("/projects", { name: "shop" });
    const projectId = created.body.id;
    for (const name of ["backend", "frontend"]) {
      await post(`/projects/${projectId}/repos`, {
        url: origins[name],
        name,
      });
    }
    const feature = await post("/specs", {
      projectId,
      type: "feature",
      slug: "order-export",
      title: "Order export",
    });
    expect(feature.status).toBe(201);
    const bug = await post("/bugs", { projectId, body: REPORT });
    expect(bug.status).toBe(201);

    const run = await runWorker({
      api: createWorkerApi(api.url, "w1"),
      executor: executor(),
      stopWhenIdle: true,
      heartbeatMs: 50,
    });
    expect(run.jobs).toBe(1);
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.stage).toBe("locate-bug");
    expect(agentRuns[0]?.placement).toBeUndefined();
    expect(agentRuns[0]?.refs).toEqual(["frontend"]);
    expect(agentRuns[0]?.prompt).toContain("不要提交");
    expect(agentRuns[0]?.specMd).toContain(REPORT);

    const view = (await (
      await fetch(`${api.url}/specs/${bug.body.id}`)
    ).json()) as {
      spec: {
        state: string;
        body: string;
        sourceSpec: { displayId: string } | null;
      };
      tickets: unknown[];
    };
    expect(view.spec.state).toBe("draft");
    expect(view.spec.sourceSpec).toMatchObject({
      displayId: `S-${feature.body.id}`,
    });
    expect(view.spec.body).toContain("src/orders.ts");
    expect(view.spec.body).toContain(`S-${feature.body.id}`);
    expect(view.tickets).toEqual([]);

    const diagnoses = await db.pool.query(
      "SELECT id FROM tickets WHERE type = 'fix'",
    );
    expect(diagnoses.rows).toEqual([]);
    const stages = await db.pool.query<{ stage: string }>(
      "SELECT DISTINCT payload->>'stage' AS stage FROM jobs",
    );
    expect(stages.rows.map((row) => row.stage)).toEqual(["locate-bug"]);
  });
});
