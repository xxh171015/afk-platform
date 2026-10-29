import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppTokenSource } from "./github-app.ts";
import { FakeGitHub } from "./testing/index.ts";
import { HostError } from "./types.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const credentials = {
  appId: "5519235",
  installationId: "176373363",
  privateKey,
};
const repo = { owner: "me", name: "afk-pilot-backend" };

let github: FakeGitHub;
let clock = Date.parse("2026-10-28T10:00:00Z");
const source = () =>
  createAppTokenSource({
    credentials,
    apiUrl: github.url,
    now: () => new Date(clock),
  });

beforeEach(async () => {
  clock = Date.parse("2026-10-28T10:00:00Z");
  github = new FakeGitHub({
    appId: "5519235",
    installationId: "176373363",
    publicKey,
    owner: "me",
    repo: "afk-pilot-backend",
  });
  github.now = () => clock;
  await github.start();
});
afterEach(() => github.stop());

describe("installation tokens", () => {
  it("are exchanged for a JWT signed with the App's key, limited to one repository and the asked permissions", async () => {
    const token = await source().tokenFor({
      repo,
      permissions: { contents: "write" },
    });
    expect(token).toBe("ghs_1");
    expect(github.tokensIssued).toEqual([
      {
        token: "ghs_1",
        repositories: ["afk-pilot-backend"],
        permissions: { contents: "write" },
      },
    ]);
  });

  it("are kept until five minutes before they expire", async () => {
    const tokens = source();
    const request = {
      repo,
      permissions: {
        pull_requests: "write" as const,
        contents: "read" as const,
      },
    };
    await tokens.tokenFor(request);
    clock += 54 * 60 * 1000; // six minutes left
    expect(await tokens.tokenFor(request)).toBe("ghs_1");
    clock += 90 * 1000; // four and a half minutes left
    expect(await tokens.tokenFor(request)).toBe("ghs_2");
  });

  it("are not shared between different permissions", async () => {
    const tokens = source();
    await tokens.tokenFor({ repo, permissions: { contents: "write" } });
    await tokens.tokenFor({ repo, permissions: { pull_requests: "read" } });
    expect(github.tokensIssued.map((t) => t.permissions)).toEqual([
      { contents: "write" },
      { pull_requests: "read" },
    ]);
  });

  it("are asked for once when two jobs ask at the same time", async () => {
    const tokens = source();
    const request = { repo, permissions: { contents: "write" as const } };
    const both = await Promise.all([
      tokens.tokenFor(request),
      tokens.tokenFor(request),
    ]);
    expect(both).toEqual(["ghs_1", "ghs_1"]);
    expect(github.tokensIssued).toHaveLength(1);
  });

  it("fail with the status when GitHub refuses, and without any secret in the message", async () => {
    const wrongKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const tokens = createAppTokenSource({
      credentials: { ...credentials, privateKey: wrongKey },
      apiUrl: github.url,
      now: () => new Date(clock),
    });
    const error = await tokens
      .tokenFor({ repo, permissions: { contents: "read" } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("PRIVATE KEY");
  });
});
