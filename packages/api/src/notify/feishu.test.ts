import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFeishuChannel,
  type FeishuHttp,
  type FeishuHttpRequest,
} from "./feishu.ts";
import type { Notice } from "./notices.ts";

const notice: Notice = {
  title: "票卡住",
  body: "T-7 写 CSV：门禁失败\nhttp://127.0.0.1:5173/tickets/7",
};

class FakeFeishu {
  readonly requests: FeishuHttpRequest[] = [];
  readonly messages: { chatId: string; uuid: string; content: unknown }[] = [];
  token = "t-test";
  expire = 7200;
  failSend = 0;
  failToken = 0;

  http: FeishuHttp = async (request) => {
    this.requests.push(request);
    if (request.url.includes("tenant_access_token")) {
      if (this.failToken > 0) {
        this.failToken -= 1;
        return { status: 500, json: { code: 1, msg: "busy" } };
      }
      return {
        status: 200,
        json: {
          code: 0,
          tenant_access_token: this.token,
          expire: this.expire,
        },
      };
    }
    const body = JSON.parse(request.body) as {
      receive_id: string;
      uuid: string;
      content: string;
    };
    if (this.failSend > 0) {
      this.failSend -= 1;
      return { status: 500, json: { code: 1, msg: "busy" } };
    }
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

let dir: string;
let secretsPath: string;
let fake: FakeFeishu;
let now: number;
const logs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afk-feishu-"));
  secretsPath = join(dir, "app.json");
  fake = new FakeFeishu();
  now = 0;
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeApp(mode = 0o600) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    secretsPath,
    JSON.stringify({ app_id: "cli_test", app_secret: "secret" }),
    { mode },
  );
  chmodSync(secretsPath, mode);
}

function channel(
  over: {
    defaultChatId?: string;
    resolveChatId?: (projectId?: number) => Promise<string | undefined>;
  } = {},
) {
  return createFeishuChannel({
    secretsPath,
    http: fake.http,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (message) => logs.push(message),
    defaultChatId: over.defaultChatId,
    resolveChatId:
      over.resolveChatId ??
      (async () => {
        throw new Error("resolveChatId should not be used in this test");
      }),
  });
}

describe("Feishu secrets", () => {
  it("closes the channel when the secrets file is missing, and notify does not call Feishu", async () => {
    const feishu = channel();
    expect(feishu.state).toEqual({ open: false, closedReason: "missing" });
    await feishu.channel.notify(notice, { eventId: 9, projectId: 1 });
    expect(fake.requests).toEqual([]);
  });

  it("closes the channel when the secrets file is readable by others", async () => {
    writeApp(0o644);
    const feishu = channel();
    expect(feishu.state).toEqual({
      open: false,
      closedReason: "permissions",
    });
    await feishu.channel.notify(notice, { eventId: 9, projectId: 1 });
    expect(fake.requests).toEqual([]);
  });
});

describe("Feishu IM cards", () => {
  beforeEach(() => writeApp());

  it("sends an interactive card with the display id, reason, and a local-page button labelled 本机链接", async () => {
    const feishu = channel({
      resolveChatId: async () => "oc_shop",
    });
    expect(feishu.state).toEqual({ open: true });
    await feishu.channel.notify(notice, { eventId: 7, projectId: 1 });
    expect(fake.messages).toHaveLength(1);
    const sent = fake.messages[0];
    expect(sent?.chatId).toBe("oc_shop");
    expect(sent?.uuid).toBe("7");
    const card = JSON.stringify(sent?.content);
    expect(card).toContain("票卡住");
    expect(card).toContain("T-7");
    expect(card).toContain("门禁失败");
    expect(card).toContain("本机链接");
    expect(card).toContain("http://127.0.0.1:5173/tickets/7");
    const send = fake.requests.find((r) => r.url.includes("/im/v1/messages"));
    expect(send?.url).toContain("receive_id_type=chat_id");
    expect(send?.headers.Authorization).toBe("Bearer t-test");
  });

  it("uses the first event id as the uuid so a retry of the same key does not create a second message", async () => {
    const feishu = channel({
      resolveChatId: async () => "oc_shop",
    });
    await feishu.channel.notify(notice, { eventId: 11, projectId: 1 });
    await feishu.channel.notify(notice, { eventId: 11, projectId: 1 });
    expect(fake.messages).toEqual([
      expect.objectContaining({ uuid: "11", chatId: "oc_shop" }),
    ]);
    expect(
      fake.requests.filter((r) => r.url.includes("/im/v1/messages")),
    ).toHaveLength(1);
  });

  it("fetches a tenant token once and reuses it until it expires", async () => {
    const feishu = channel({
      resolveChatId: async () => "oc_shop",
    });
    await feishu.channel.notify(notice, { eventId: 1, projectId: 1 });
    now = 60_000;
    await feishu.channel.notify(notice, { eventId: 2, projectId: 1 });
    expect(
      fake.requests.filter((r) => r.url.includes("tenant_access_token")),
    ).toHaveLength(1);
    now = 7_200_000;
    await feishu.channel.notify(notice, { eventId: 3, projectId: 1 });
    expect(
      fake.requests.filter((r) => r.url.includes("tenant_access_token")),
    ).toHaveLength(2);
  });

  it("queues sends at 5 QPS", async () => {
    const times: number[] = [];
    const inner = fake.http;
    fake.http = async (request) => {
      if (request.url.includes("/im/v1/messages")) times.push(now);
      return inner(request);
    };
    const feishu = channel({
      resolveChatId: async () => "oc_shop",
    });
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((id) =>
        feishu.channel.notify(notice, { eventId: id, projectId: 1 }),
      ),
    );
    expect(times).toHaveLength(6);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(200);
    }
  });

  it("retries a failed send three times with backoff, then logs and still delivers later notices", async () => {
    fake.failSend = 4;
    const feishu = channel({
      resolveChatId: async () => "oc_shop",
    });
    await feishu.channel.notify(notice, { eventId: 1, projectId: 1 });
    expect(fake.messages).toEqual([]);
    expect(logs.some((line) => /feishu/i.test(line))).toBe(true);
    const sendAttempts = fake.requests.filter((r) =>
      r.url.includes("/im/v1/messages"),
    );
    expect(sendAttempts).toHaveLength(4);
    fake.failSend = 0;
    await feishu.channel.notify(notice, { eventId: 2, projectId: 1 });
    expect(fake.messages).toEqual([
      expect.objectContaining({ uuid: "2", chatId: "oc_shop" }),
    ]);
  });

  it("sends to the default chat when the project has none, and skips Feishu when neither is set", async () => {
    const withDefault = channel({
      defaultChatId: "oc_default",
      resolveChatId: async () => undefined,
    });
    await withDefault.channel.notify(notice, { eventId: 1, projectId: 1 });
    expect(fake.messages).toEqual([
      expect.objectContaining({ chatId: "oc_default", uuid: "1" }),
    ]);
    fake.messages.length = 0;
    fake.requests.length = 0;
    const neither = channel({
      resolveChatId: async () => undefined,
    });
    await neither.channel.notify(notice, { eventId: 2 });
    expect(fake.messages).toEqual([]);
    expect(
      fake.requests.filter((r) => r.url.includes("/im/v1/messages")),
    ).toEqual([]);
  });
});
