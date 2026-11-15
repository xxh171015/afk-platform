import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "@afk/cli";
import { GIB } from "@afk/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  FakeClock,
  FakeWorker,
  listen,
  type RunningApi,
  testApp,
} from "../test/fake-worker.ts";
import { importBody } from "../test/ticket-files.ts";
import { maybeSendDailyDigest } from "./daily-digest.ts";
import type { FeishuHttp, FeishuHttpRequest } from "./feishu.ts";

class FakeFeishu {
  readonly requests: FeishuHttpRequest[] = [];
  readonly messages: { chatId: string; uuid: string; content: unknown }[] = [];
  token = "t-test";

  readonly http: FeishuHttp = async (request) => {
    this.requests.push(request);
    if (request.url.includes("tenant_access_token")) {
      return {
        status: 200,
        json: {
          code: 0,
          tenant_access_token: this.token,
          expire: 7200,
        },
      };
    }
    const body = JSON.parse(request.body) as {
      receive_id: string;
      uuid: string;
      content: string;
    };
    if (!this.messages.some((row) => row.uuid === body.uuid)) {
      this.messages.push({
        chatId: body.receive_id,
        uuid: body.uuid,
        content: JSON.parse(body.content),
      });
    }
    return { status: 200, json: { code: 0, data: { message_id: "om_1" } } };
  };
}

let db: TestDatabase;
let api: RunningApi;
let worker: FakeWorker;
let clock: FakeClock;
let fake: FakeFeishu;
let dir: string;
let secretsPath: string;
let macos: string[][];
let freeBytes: number;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "afk-feishu-api-"));
  secretsPath = join(dir, "app.json");
  fake = new FakeFeishu();
  macos = [];
  freeBytes = 20 * GIB;
  clock = new FakeClock();
});
afterEach(async () => {
  await api?.close();
  await db?.drop();
  rmSync(dir, { recursive: true, force: true });
});

function writeApp(mode = 0o600) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    secretsPath,
    JSON.stringify({ app_id: "cli_test", app_secret: "secret" }),
    { mode },
  );
  chmodSync(secretsPath, mode);
}

async function start(over: { defaultChatId?: string; secrets?: boolean } = {}) {
  if (over.secrets !== false) writeApp();
  api = await listen(
    testApp({
      pool: db.pool,
      clock: clock.now,
      schedule: clock.schedule,
      liveNotifications: true,
      macosRun: async (_cmd, args) => {
        macos.push(args);
      },
      statDisk: async () => ({ freeBytes, dirBytes: 4096 }),
      feishu: {
        secretsPath:
          over.secrets === false ? join(dir, "missing.json") : secretsPath,
        http: fake.http,
        defaultChatId: over.defaultChatId,
        clock: () => Date.now(),
        sleep: async () => undefined,
      },
    }),
  );
  worker = new FakeWorker(api.url, "w1", []);
}

async function call(
  method: "GET" | "POST" | "PATCH",
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
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function runningProject(chatId?: string) {
  const created = await call("POST", "/projects", { name: "shop" });
  const projectId = created.body.id as number;
  if (chatId !== undefined) {
    expect(
      (await call("PATCH", `/projects/${projectId}`, { feishuChatId: chatId }))
        .status,
    ).toBe(200);
  }
  await call("POST", `/projects/${projectId}/repos`, {
    url: "git@x:backend",
    role: "backend",
  });
  const spec = await call("POST", "/specs", {
    projectId,
    type: "feature",
    slug: "s",
    title: "导出订单",
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
              title: "写 CSV",
              modules: ["src/a/**"],
              acceptance: ["it works"],
            },
          ],
        }),
      )
    ).status,
  ).toBe(200);
  expect((await call("POST", `/specs/${specId}/confirm`)).status).toBe(200);
  return { projectId, specId };
}

async function blockTicket() {
  const job = (await worker.claim()).body.job as {
    id: number;
    attempt: number;
    payload: { ticketId: number; specId: number };
  };
  await worker.complete(job.id, job.attempt, {
    stage: "implement",
    outcome: "agent-gave-up",
    run: {
      output: {
        status: "cannot-proceed",
        blockedReason: "agent-gave-up",
        detail: "needs a decision",
      },
    },
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    clock.advanceSeconds(30);
    await clock.flush();
    if (macos.length > 0 || fake.messages.length > 0) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return job;
}

async function waitForMacos() {
  const deadline = Date.now() + 2_000;
  while (macos.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(macos.length).toBeGreaterThan(0);
}

async function plat(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { AFK_API_URL: api.url },
    readFile: async () => {
      throw new Error("ENOENT");
    },
    readDirectory: async () => {
      throw new Error("ENOENT");
    },
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

describe("Feishu dispatch and the workbench", () => {
  it("shows the Feishu channel closed in the status area when the secrets file is missing, still notifies macOS, and starts", async () => {
    await start({ secrets: false });
    const board = await call("GET", "/workbench");
    expect(board.status).toBe(200);
    expect(board.body.status).toMatchObject({
      feishu: { open: false, closedReason: "missing" },
    });
    freeBytes = 9 * GIB;
    expect((await call("GET", "/workbench")).status).toBe(200);
    await waitForMacos();
    expect(fake.requests).toEqual([]);
  });

  it("closes the channel when the secrets file is world-readable, and still notifies macOS", async () => {
    writeApp(0o644);
    api = await listen(
      testApp({
        pool: db.pool,
        clock: clock.now,
        schedule: clock.schedule,
        liveNotifications: true,
        macosRun: async (_cmd, args) => {
          macos.push(args);
        },
        statDisk: async () => ({ freeBytes, dirBytes: 4096 }),
        feishu: {
          secretsPath,
          http: fake.http,
          sleep: async () => undefined,
        },
      }),
    );
    const board = await call("GET", "/workbench");
    expect(board.body.status).toMatchObject({
      feishu: { open: false, closedReason: "permissions" },
    });
    freeBytes = 9 * GIB;
    expect((await call("GET", "/workbench")).status).toBe(200);
    await waitForMacos();
    expect(fake.requests).toEqual([]);
  });

  it("sends a Feishu card to the project's group with a local-page button labelled 本机链接", async () => {
    await start();
    await runningProject("oc_shop");
    await blockTicket();
    expect(fake.messages).toHaveLength(1);
    const sent = fake.messages[0];
    expect(sent?.chatId).toBe("oc_shop");
    const card = JSON.stringify(sent?.content);
    expect(card).toContain("票卡住");
    expect(card).toContain("T-1");
    expect(card).toContain("本机链接");
    expect(card).toContain("http://127.0.0.1:5173/tickets/1");
    expect(macos.length).toBeGreaterThan(0);
    const eventId = Number(sent?.uuid);
    expect(eventId).toBeGreaterThan(0);
    const events = await db.pool.query(
      "SELECT id::text AS id FROM events WHERE id = $1",
      [eventId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("sends to the default group when the project has no chat", async () => {
    await start({ defaultChatId: "oc_default" });
    await runningProject();
    await blockTicket();
    expect(fake.messages.map((m) => m.chatId)).toEqual(["oc_default"]);
  });

  it("does not send to Feishu when the project has no chat and no default group, and still notifies macOS", async () => {
    await start();
    await runningProject();
    await blockTicket();
    expect(fake.messages).toEqual([]);
    expect(macos.length).toBeGreaterThan(0);
  });
});

describe("Feishu test send", () => {
  it("sends through the same Feishu path from HTTP and plat feishu test --project", async () => {
    await start();
    const { projectId } = await runningProject("oc_shop");
    fake.messages.length = 0;
    fake.requests.length = 0;
    const posted = await call("POST", `/projects/${projectId}/feishu-test`);
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual({ sent: true, chatId: "oc_shop" });
    expect(fake.messages).toEqual([
      expect.objectContaining({ chatId: "oc_shop" }),
    ]);
    expect(JSON.stringify(fake.messages[0]?.content)).toContain("本机链接");
    fake.messages.length = 0;
    const cli = await plat("feishu", "test", "--project", String(projectId));
    expect(cli).toEqual({
      code: 0,
      stdout: "sent a test card to oc_shop\n",
      stderr: "",
    });
    expect(fake.messages).toEqual([
      expect.objectContaining({ chatId: "oc_shop" }),
    ]);
  });

  it("does not call Feishu when the channel is closed", async () => {
    await start({ secrets: false });
    const created = await call("POST", "/projects", { name: "shop" });
    const posted = await call(
      "POST",
      `/projects/${created.body.id as number}/feishu-test`,
    );
    expect(posted.status).toBe(409);
    expect(posted.body).toEqual({ error: "feishu channel is closed" });
    expect(fake.requests).toEqual([]);
  });
});

const BEIJING_8AM = new Date("2026-01-01T00:00:00Z");
const BEIJING_9AM = new Date("2026-01-01T01:00:00Z");
const OPENED_MS = 12 * 3600 * 1000;
const PR_URL = "https://github.com/me/shop/pull/7";

async function waitForFeishu(count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (fake.messages.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(fake.messages).toHaveLength(count);
}

async function pendingSpec(
  projectId: number,
  options: {
    title: string;
    slug: string;
    prUrl?: string;
    conflicts?: boolean;
    needsHuman?: number;
    deferred?: number;
    state?: "awaiting-review" | "partially-merged";
  },
) {
  const repo = await db.pool.query<{ id: number }>(
    "SELECT id FROM repos WHERE project_id = $1",
    [projectId],
  );
  const spec = await db.pool.query<{ id: number }>(
    `INSERT INTO specs (project_id, type, slug, title, state)
     VALUES ($1, 'feature', $2, $3, $4)
     RETURNING id`,
    [
      projectId,
      options.slug,
      options.title,
      options.state ?? "awaiting-review",
    ],
  );
  const specId = spec.rows[0].id;
  await db.pool.query(
    `INSERT INTO pull_requests (spec_id, repo_id, number, url, state, head_sha, conflicts_with_default, synced_at)
     VALUES ($1, $2, 7, $3, 'open', 'abc', $4, $5)`,
    [
      specId,
      repo.rows[0].id,
      options.prUrl ?? PR_URL,
      options.conflicts === true,
      BEIJING_9AM,
    ],
  );
  const needsHuman = options.needsHuman ?? 0;
  const deferred = options.deferred ?? 0;
  const needsDecision = [
    ...Array.from({ length: needsHuman }, (_, i) => ({
      kind: "needs-human",
      id: `R-1#${i}`,
      source: "T-1 implement",
      text: `ask ${i}`,
    })),
    ...Array.from({ length: deferred }, (_, i) => ({
      kind: "deferred",
      id: `R-1#d${i}`,
      source: "T-1 implement",
      text: `later ${i}`,
      ref: "new",
    })),
  ];
  await db.pool.query(
    `INSERT INTO acceptance_packs (spec_id, content) VALUES ($1, $2::jsonb)`,
    [
      specId,
      JSON.stringify({
        generatedAt: BEIJING_9AM.toISOString(),
        mergeOrder: { ordered: [], after: {}, unordered: [] },
        orderBroken: [],
        repos: [],
        cancelledTickets: [],
        agentSeconds: 0,
        needsDecision,
      }),
    ],
  );
  await db.pool.query(
    `UPDATE events SET at = $2
     WHERE spec_id = $1 AND type = 'spec' AND to_state = 'awaiting-review'`,
    [specId, new Date(BEIJING_9AM.getTime() - OPENED_MS)],
  );
  return specId;
}

async function digestEvents() {
  return db.pool.query<{
    kind: string;
    project_id: string | null;
    body: string | null;
  }>(
    `SELECT data->>'kind' AS kind, data->>'projectId' AS project_id, data->>'body' AS body
     FROM events WHERE type = 'system' AND data->>'kind' = 'daily-digest'
     ORDER BY id`,
  );
}

describe("daily digest of awaiting-review specs", () => {
  it("records and sends one digest per project with pending specs at Beijing 09:00, matching the spec page, and skips empty projects and hours before 09:00", async () => {
    await start({ defaultChatId: "oc_default" });
    const shop = await call("POST", "/projects", { name: "shop" });
    const shopId = shop.body.id as number;
    expect(
      (await call("PATCH", `/projects/${shopId}`, { feishuChatId: "oc_shop" }))
        .status,
    ).toBe(200);
    await call("POST", `/projects/${shopId}/repos`, {
      url: "git@x:backend",
      role: "backend",
    });
    const specId = await pendingSpec(shopId, {
      title: "导出订单",
      slug: "export",
      conflicts: true,
      needsHuman: 2,
      deferred: 1,
    });
    const empty = await call("POST", "/projects", { name: "empty" });
    await call("POST", `/projects/${empty.body.id as number}/repos`, {
      url: "git@x:empty",
      role: "backend",
    });

    await maybeSendDailyDigest(db.pool, BEIJING_8AM);
    expect((await digestEvents()).rows).toEqual([]);
    expect(fake.messages).toEqual([]);

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    const events = await digestEvents();
    expect(events.rows).toEqual([
      {
        kind: "daily-digest",
        project_id: String(shopId),
        body: expect.stringContaining("S-1") as string,
      },
    ]);

    const view = await call("GET", `/specs/${specId}`);
    expect(view.status).toBe(200);
    const spec = view.body.spec as { displayId: string; title: string };
    const pulls = view.body.pullRequests as { url: string }[];
    const pack = view.body.acceptancePack as {
      needsDecision: { kind: string }[];
    };
    expect(spec).toMatchObject({ displayId: "S-1", title: "导出订单" });
    expect(pulls.map((row) => row.url)).toEqual([PR_URL]);
    expect(
      pack.needsDecision.filter((item) => item.kind === "needs-human"),
    ).toHaveLength(2);
    expect(
      pack.needsDecision.filter((item) => item.kind === "deferred"),
    ).toHaveLength(1);

    await waitForFeishu(1);
    expect(fake.messages[0]?.chatId).toBe("oc_shop");
    const card = JSON.stringify(fake.messages[0]?.content);
    expect(card).toContain(spec.displayId);
    expect(card).toContain(spec.title);
    expect(card).toContain(PR_URL);
    expect(card).toContain("开出 12 小时");
    expect(card).toContain("needs-human 2");
    expect(card).toContain("deferred 1");
    expect(card).toContain("与默认分支冲突");
    expect(events.rows[0]?.body).toContain(spec.displayId);
    expect(events.rows[0]?.body).toContain(spec.title);
    expect(events.rows[0]?.body).toContain(PR_URL);
  });

  it("does not resend on a second check the same day or after an API restart, and sends again the next Beijing morning", async () => {
    await start({ defaultChatId: "oc_default" });
    const shop = await call("POST", "/projects", { name: "shop" });
    const shopId = shop.body.id as number;
    await call("POST", `/projects/${shopId}/repos`, {
      url: "git@x:backend",
      role: "backend",
    });
    await pendingSpec(shopId, { title: "导出订单", slug: "export" });

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    await waitForFeishu(1);
    expect((await digestEvents()).rows).toHaveLength(1);

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    expect((await digestEvents()).rows).toHaveLength(1);

    await api.close();
    fake.messages.length = 0;
    await start({ defaultChatId: "oc_default" });
    await maybeSendDailyDigest(db.pool, new Date("2026-01-01T04:00:00Z"));
    expect((await digestEvents()).rows).toHaveLength(1);
    expect(fake.messages).toEqual([]);

    await maybeSendDailyDigest(db.pool, new Date("2026-01-02T01:00:00Z"));
    expect((await digestEvents()).rows).toHaveLength(2);
    await waitForFeishu(1);
  });

  it("puts each awaiting-review and partially-merged spec of a project on its own line", async () => {
    await start({ defaultChatId: "oc_default" });
    const shop = await call("POST", "/projects", { name: "shop" });
    const shopId = shop.body.id as number;
    await call("POST", `/projects/${shopId}/repos`, {
      url: "git@x:backend",
      role: "backend",
    });
    await pendingSpec(shopId, { title: "导出订单", slug: "export" });
    await pendingSpec(shopId, {
      title: "入库单",
      slug: "inbound",
      state: "partially-merged",
      prUrl: "https://github.com/me/shop/pull/8",
    });

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    const events = await digestEvents();
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.body?.split("\n")).toEqual([
      expect.stringContaining("导出订单"),
      expect.stringContaining("入库单"),
    ]);
    await waitForFeishu(1);
    const card = JSON.stringify(fake.messages[0]?.content);
    expect(card).toContain("导出订单");
    expect(card).toContain("入库单");
    expect(card).toContain("https://github.com/me/shop/pull/8");
  });

  it("sends to the project's Feishu group when set and to the default group otherwise", async () => {
    await start({ defaultChatId: "oc_default" });
    const shop = await call("POST", "/projects", { name: "shop" });
    const shopId = shop.body.id as number;
    expect(
      (await call("PATCH", `/projects/${shopId}`, { feishuChatId: "oc_shop" }))
        .status,
    ).toBe(200);
    await call("POST", `/projects/${shopId}/repos`, {
      url: "git@x:shop",
      role: "backend",
    });
    await pendingSpec(shopId, { title: "导出订单", slug: "export" });
    const warehouse = await call("POST", "/projects", { name: "warehouse" });
    const warehouseId = warehouse.body.id as number;
    await call("POST", `/projects/${warehouseId}/repos`, {
      url: "git@x:warehouse",
      role: "backend",
    });
    await pendingSpec(warehouseId, {
      title: "入库单",
      slug: "inbound",
      prUrl: "https://github.com/me/warehouse/pull/3",
    });

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    await waitForFeishu(2);
    expect(fake.messages.map((row) => row.chatId).sort()).toEqual([
      "oc_default",
      "oc_shop",
    ]);
    const shopCard = fake.messages.find((row) => row.chatId === "oc_shop");
    const defaultCard = fake.messages.find(
      (row) => row.chatId === "oc_default",
    );
    expect(JSON.stringify(shopCard?.content)).toContain("导出订单");
    expect(JSON.stringify(defaultCard?.content)).toContain("入库单");
  });

  it("uses MR wording for a GitLab project's morning digest and PR for GitHub", async () => {
    await start({ defaultChatId: "oc_default" });
    const github = await call("POST", "/projects", { name: "shop" });
    const githubId = github.body.id as number;
    await call("POST", `/projects/${githubId}/repos`, {
      url: "https://github.com/me/shop.git",
      role: "backend",
    });
    await pendingSpec(githubId, {
      title: "导出订单",
      slug: "export",
      prUrl: "https://github.com/me/shop/pull/7",
    });
    const gitlab = await call("POST", "/projects", { name: "lab" });
    const gitlabId = gitlab.body.id as number;
    await call("POST", `/projects/${gitlabId}/repos`, {
      url: "https://gitlab.com/acme/backend.git",
      role: "backend",
    });
    await pendingSpec(gitlabId, {
      title: "入库单",
      slug: "inbound",
      prUrl: "https://gitlab.com/acme/backend/-/merge_requests/3",
    });

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    const events = await digestEvents();
    const githubBody = events.rows.find(
      (row) => row.project_id === String(githubId),
    )?.body;
    const gitlabBody = events.rows.find(
      (row) => row.project_id === String(gitlabId),
    )?.body;
    expect(githubBody).toContain("PR 开出");
    expect(githubBody).not.toContain("MR 开出");
    expect(gitlabBody).toContain("MR 开出");
    expect(gitlabBody).not.toContain("PR 开出");

    await waitForFeishu(2);
    const cards = fake.messages.map((row) => JSON.stringify(row.content));
    expect(
      cards.some(
        (card) => card.includes("待合并 PR") && card.includes("导出订单"),
      ),
    ).toBe(true);
    expect(
      cards.some(
        (card) => card.includes("待合并 MR") && card.includes("入库单"),
      ),
    ).toBe(true);
  });

  it("still notifies macOS when Feishu is closed", async () => {
    await start({ secrets: false });
    const shop = await call("POST", "/projects", { name: "shop" });
    const shopId = shop.body.id as number;
    await call("POST", `/projects/${shopId}/repos`, {
      url: "git@x:backend",
      role: "backend",
    });
    await pendingSpec(shopId, { title: "导出订单", slug: "export" });

    await maybeSendDailyDigest(db.pool, BEIJING_9AM);
    expect((await digestEvents()).rows).toHaveLength(1);
    const deadline = Date.now() + 2_000;
    while (macos.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(macos.length).toBeGreaterThan(0);
    expect(macos.some((args) => args.join(" ").includes("待合并 PR"))).toBe(
      true,
    );
    expect(fake.requests).toEqual([]);
  });
});
