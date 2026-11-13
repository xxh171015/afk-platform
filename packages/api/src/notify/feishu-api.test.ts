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
