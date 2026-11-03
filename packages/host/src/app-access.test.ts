import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAppAccess } from "./app-access.ts";
import { FakeGitHub } from "./testing/index.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const credentials = { appId: "55", installationId: "7", privateKey };
const repo = { owner: "acme", name: "backend" };

let github: FakeGitHub;
beforeEach(async () => {
  github = new FakeGitHub({
    appId: "55",
    installationId: "7",
    publicKey,
    owner: "acme",
    repo: "backend",
  });
  await github.start();
});
afterEach(() => github.stop());

const check = () => checkAppAccess({ credentials, apiUrl: github.url }, repo);

describe("whether the GitHub App can work on a repo", () => {
  it("is ok when the installation has the repo and every permission the platform uses", async () => {
    expect(await check()).toEqual({ state: "ok" });
  });

  it("is not-installed, with the installation's settings page, when the repo was not given to the installation", async () => {
    github.installedRepos = ["frontend"];
    expect(await check()).toEqual({
      state: "not-installed",
      fixUrl: "https://github.com/settings/installations/7",
    });
  });

  it("is not-installed, with the App's install page, when the installation is gone", async () => {
    github.installed = false;
    expect(await check()).toEqual({
      state: "not-installed",
      fixUrl: "https://github.com/apps/afk-bot/installations/new",
    });
  });

  it("names each permission that is missing or only readable where writing is needed", async () => {
    github.installationPermissions = {
      contents: "read",
      pull_requests: "write",
      metadata: "read",
    };
    expect(await check()).toEqual({
      state: "missing-permissions",
      missing: ["contents: write", "checks: read", "statuses: read"],
      fixUrl: "https://github.com/settings/installations/7",
    });
  });
});
