import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseEnvFile } from "./config.ts";

const sources = (
  env: Record<string, string>,
  files: Record<string, string> = {},
) => ({
  env,
  homedir: "/home/me",
  readFile: (path: string) => files[path],
});
const complete = {
  CURSOR_API_KEY: "key",
  AFK_MODEL: "some-model",
};
const problemsOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines, with comments, export and quotes", () => {
    expect(
      parseEnvFile(
        '# keys\nexport CURSOR_API_KEY="abc=def"\n\nOTHER=x\nnot a line\n',
      ),
    ).toEqual({ CURSOR_API_KEY: "abc=def", OTHER: "x" });
  });
});

describe("the worker's configuration", () => {
  it("has defaults for everything but the key and the model", () => {
    const config = loadConfig(sources(complete));
    expect(config).toMatchObject({
      apiUrl: "http://127.0.0.1:3000",
      home: "/home/me/.afk",
      slots: 2,
      image: "sandcastle:afk-platform",
      model: "some-model",
      cursorApiKey: "key",
      credentialsDir: "/home/me/.afk/secrets/github-app",
      gitlabDir: "/home/me/.afk/secrets/gitlab",
      npmRegistries: [],
    });
    expect(config.workerId).not.toBe("");
  });

  it("reads the npm registries, in order, from the environment or ~/.afk/env", () => {
    const fromFile = loadConfig(
      sources(complete, {
        "/home/me/.afk/env":
          'AFK_NPM_REGISTRIES="https://registry.npmmirror.com  https://nexus.example/npm/"\n',
      }),
    );
    expect(fromFile.npmRegistries).toEqual([
      "https://registry.npmmirror.com",
      "https://nexus.example/npm/",
    ]);
    const fromEnv = loadConfig(
      sources({ ...complete, AFK_NPM_REGISTRIES: "https://a.example" }),
    );
    expect(fromEnv.npmRegistries).toEqual(["https://a.example"]);
    expect(() =>
      loadConfig(sources({ ...complete, AFK_NPM_REGISTRIES: "not-a-url" })),
    ).toThrow(/AFK_NPM_REGISTRIES has something that is not an address/);
  });

  it("takes the Cursor key from ~/.afk/env, and only that key", () => {
    const { CURSOR_API_KEY: _, ...rest } = complete;
    const config = loadConfig(
      sources(rest, {
        "/home/me/.afk/env": "CURSOR_API_KEY=from-file\nGITHUB_TOKEN=ghp_x\n",
      }),
    );
    expect(config.cursorApiKey).toBe("from-file");
    expect(JSON.stringify(config)).not.toContain("ghp_x");
  });

  it("prefers the environment over the file", () => {
    const config = loadConfig(
      sources(complete, { "/home/me/.afk/env": "CURSOR_API_KEY=from-file\n" }),
    );
    expect(config.cursorApiKey).toBe("key");
  });

  it("names every problem at once, one sentence each", () => {
    const problems = problemsOf(() =>
      loadConfig(sources({ AFK_SLOTS: "0", AFK_API_URL: "not a url" })),
    );
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/CURSOR_API_KEY is not set/);
    expect(problems.join("\n")).toMatch(/AFK_MODEL is not set/);
    expect(problems.join("\n")).toMatch(/AFK_SLOTS must be/);
    expect(problems.join("\n")).toMatch(/AFK_API_URL is not an address/);
  });
});

describe("pnpm worker", () => {
  it("stops at once, saying what is missing, when it is not configured", () => {
    const home = mkdtempSync(join(tmpdir(), "afk-worker-home-"));
    try {
      const main = fileURLToPath(new URL("./main.ts", import.meta.url));
      const result = spawnSync(process.execPath, [main], {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the worker cannot start");
      expect(result.stderr).toContain("CURSOR_API_KEY is not set");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names a sandbox image that is not there (or Docker that is not)", () => {
    const home = mkdtempSync(join(tmpdir(), "afk-worker-home-"));
    try {
      // credentials that load, so the next check is the image
      const dir = join(home, ".afk", "secrets", "github-app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "app.json"),
        '{"appId":"1","installationId":"2"}',
      );
      writeFileSync(join(dir, "private-key.pem"), "key", { mode: 0o600 });
      const main = fileURLToPath(new URL("./main.ts", import.meta.url));
      const result = spawnSync(process.execPath, [main], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CURSOR_API_KEY: "k",
          AFK_MODEL: "m",
          AFK_SANDBOX_IMAGE: "afk-test-image-that-does-not-exist:none",
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /docker is not available|afk-test-image-that-does-not-exist:none is not built/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names missing GitHub App credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "afk-worker-home-"));
    try {
      const main = fileURLToPath(new URL("./main.ts", import.meta.url));
      const result = spawnSync(process.execPath, [main], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CURSOR_API_KEY: "k",
          AFK_MODEL: "m",
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHub App credentials");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
