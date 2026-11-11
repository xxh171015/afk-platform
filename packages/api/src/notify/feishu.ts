import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pageUrl } from "../page-url.ts";
import type { NotificationChannel, NotificationMeta } from "./channel.ts";
import type { Notice } from "./notices.ts";

// Feishu app credentials live in ~/.afk/secrets/feishu/app.json (mode 600), not in the
// database and not under AFK_HOME. Missing or world-readable: the channel stays closed.

export const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";
export const FEISHU_QPS = 5;
export const FEISHU_SEND_ATTEMPTS = 4;
export const FEISHU_BUTTON_LABEL = "打开控制塔（本机链接）";

export type FeishuClosedReason = "missing" | "permissions" | "invalid";

export type FeishuChannelState =
  | { open: true }
  | { open: false; closedReason: FeishuClosedReason };

export interface FeishuHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FeishuHttpResponse {
  status: number;
  json: unknown;
}

export type FeishuHttp = (
  request: FeishuHttpRequest,
) => Promise<FeishuHttpResponse>;

export function feishuSecretsPath(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  return (
    env.AFK_FEISHU_APP ?? join(home, ".afk", "secrets", "feishu", "app.json")
  );
}

export function inspectFeishuSecrets(path: string): FeishuChannelState {
  try {
    const mode = statSync(path).mode;
    if (mode & 0o077) return { open: false, closedReason: "permissions" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      app_id?: unknown;
      app_secret?: unknown;
    };
    if (
      typeof parsed.app_id !== "string" ||
      parsed.app_id === "" ||
      typeof parsed.app_secret !== "string" ||
      parsed.app_secret === ""
    ) {
      return { open: false, closedReason: "invalid" };
    }
    return { open: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { open: false, closedReason: "missing" };
    }
    return { open: false, closedReason: "invalid" };
  }
}

function readApp(path: string): { appId: string; appSecret: string } | null {
  try {
    const mode = statSync(path).mode;
    if (mode & 0o077) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      app_id?: unknown;
      app_secret?: unknown;
    };
    if (
      typeof parsed.app_id !== "string" ||
      parsed.app_id === "" ||
      typeof parsed.app_secret !== "string" ||
      parsed.app_secret === ""
    ) {
      return null;
    }
    return { appId: parsed.app_id, appSecret: parsed.app_secret };
  } catch {
    return null;
  }
}

export function pageLinkOf(notice: Notice): string {
  const urls = notice.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line));
  return urls[0] ?? pageUrl("/");
}

export function cardTextOf(notice: Notice): string {
  return notice.body
    .split("\n")
    .filter((line) => !/^https?:\/\//.test(line.trim()))
    .join("\n");
}

export function feishuCard(notice: Notice): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: notice.title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: cardTextOf(notice) },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: FEISHU_BUTTON_LABEL },
            type: "primary",
            url: pageLinkOf(notice),
          },
        ],
      },
    ],
  };
}

async function defaultHttp(
  request: FeishuHttpRequest,
): Promise<FeishuHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const json: unknown = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function replyError(response: FeishuHttpResponse, what: string): Error {
  const body = response.json as { code?: number; msg?: string } | null;
  const msg = body?.msg ?? `HTTP ${response.status}`;
  return new Error(`${what}: ${msg}`);
}

function isOk(response: FeishuHttpResponse): boolean {
  const code = (response.json as { code?: number } | null)?.code;
  return response.status < 400 && code === 0;
}

export type FeishuTestResult =
  | { sent: true; chatId: string }
  | { sent: false; reason: "channel-closed" | "no-chat" | "send-failed" };

export interface FeishuChannelOptions {
  secretsPath: string;
  http?: FeishuHttp;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaultChatId?: string;
  resolveChatId: (projectId?: number) => Promise<string | undefined>;
  log?: (message: string) => void;
  apiBase?: string;
}

export interface FeishuHandle {
  state: FeishuChannelState;
  channel: NotificationChannel;
  sendTest: (projectId: number) => Promise<FeishuTestResult>;
}

export function createFeishuChannel(
  options: FeishuChannelOptions,
): FeishuHandle {
  const state = inspectFeishuSecrets(options.secretsPath);
  const http = options.http ?? defaultHttp;
  const clock = options.clock ?? Date.now;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? ((message) => console.error(message));
  const apiBase = (options.apiBase ?? FEISHU_OPEN_API).replace(/\/+$/, "");
  const gapMs = Math.ceil(1000 / FEISHU_QPS);
  const sent = new Set<string>();
  let nextSendAt = 0;
  let chain: Promise<void> = Promise.resolve();
  let cached: { token: string; expiresAt: number } | undefined;

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const waitTurn = async () => {
    const now = clock();
    const slot = Math.max(now, nextSendAt);
    nextSendAt = slot + gapMs;
    if (slot > now) await sleep(slot - now);
  };

  const token = async (appId: string, appSecret: string): Promise<string> => {
    if (cached && clock() < cached.expiresAt) return cached.token;
    const response = await http({
      url: `${apiBase}/auth/v3/tenant_access_token/internal`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!isOk(response)) throw replyError(response, "feishu token");
    const body = response.json as {
      tenant_access_token?: string;
      expire?: number;
    };
    if (!body.tenant_access_token) throw new Error("feishu token: missing");
    const expireSec = body.expire ?? 7200;
    const skewSec = Math.min(60, Math.floor(expireSec / 2));
    cached = {
      token: body.tenant_access_token,
      expiresAt: clock() + Math.max(0, expireSec - skewSec) * 1000,
    };
    return cached.token;
  };

  const postMessage = async (
    access: string,
    chatId: string,
    uuid: string,
    notice: Notice,
  ) => {
    const response = await http({
      url: `${apiBase}/im/v1/messages?receive_id_type=chat_id`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(feishuCard(notice)),
        uuid,
      }),
    });
    if (!isOk(response)) throw replyError(response, "feishu send");
  };

  const deliver = async (notice: Notice, chatId: string, uuid: string) => {
    const app = readApp(options.secretsPath);
    if (!app) throw new Error("feishu secrets unavailable");
    const delays = [200, 400, 800];
    for (let attempt = 0; attempt < FEISHU_SEND_ATTEMPTS; attempt++) {
      try {
        await waitTurn();
        const access = await token(app.appId, app.appSecret);
        await postMessage(access, chatId, uuid, notice);
        sent.add(uuid);
        return;
      } catch (error) {
        if (attempt === FEISHU_SEND_ATTEMPTS - 1) {
          log(
            `feishu send failed after ${FEISHU_SEND_ATTEMPTS} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        await sleep(delays[attempt] ?? 800);
      }
    }
  };

  const chatOf = async (projectId?: number): Promise<string | undefined> => {
    const fromProject = await options.resolveChatId(projectId);
    if (fromProject) return fromProject;
    return options.defaultChatId || undefined;
  };

  const channel: NotificationChannel = {
    async notify(notice, meta?: NotificationMeta) {
      if (!state.open) return;
      const uuid = meta?.eventId == null ? undefined : String(meta.eventId);
      if (uuid === undefined) return;
      if (sent.has(uuid)) return;
      await enqueue(async () => {
        if (sent.has(uuid)) return;
        try {
          const chatId = await chatOf(meta?.projectId);
          if (!chatId) return;
          await deliver(notice, chatId, uuid);
        } catch (error) {
          log(
            `feishu send failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
    },
  };

  return {
    state,
    channel,
    async sendTest(projectId) {
      if (!state.open) return { sent: false, reason: "channel-closed" };
      const chatId = await chatOf(projectId);
      if (!chatId) return { sent: false, reason: "no-chat" };
      const uuid = `test-${projectId}-${clock()}`;
      const testNotice: Notice = {
        title: "飞书测试",
        body: `测试发送\n${pageUrl(`/projects/${projectId}`)}`,
      };
      await enqueue(async () => {
        await deliver(testNotice, chatId, uuid);
      });
      if (!sent.has(uuid)) return { sent: false, reason: "send-failed" };
      return { sent: true, chatId };
    },
  };
}
