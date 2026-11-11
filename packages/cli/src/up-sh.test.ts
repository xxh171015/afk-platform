import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// scripts/up.sh --check: at least one kind of code-host credentials, GitLab tokens
// checked against the user API. Docker and the sandbox image are stubbed so the
// host-credential behaviour is what these tests see.

const upSh = fileURLToPath(new URL("../../../scripts/up.sh", import.meta.url));

const TOKEN = "glpat-test-token";

let trash: string[] = [];
afterEach(() => {
  for (const path of trash) rmSync(path, { recursive: true, force: true });
  trash = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function stubDocker(): string {
  const dir = tempDir("afk-up-bin-");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then exit 0; fi
echo "unexpected docker $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

function listenGitLabUser(options: {
  token: string;
  username: string;
  expiresAt: string | null;
  userStatus?: number;
}): Promise<{ host: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      for await (const chunk of req) void chunk;
      const url = new URL(req.url ?? "/", "http://gitlab.example");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers["private-token"] !== options.token)
        return json(401, { message: "401 Unauthorized" });
      if (req.method === "GET" && url.pathname === "/api/v4/user") {
        if (options.userStatus && options.userStatus !== 200)
          return json(options.userStatus, { message: "error" });
        return json(200, { id: 1, username: options.username });
      }
      if (
        req.method === "GET" &&
        url.pathname === "/api/v4/personal_access_tokens/self"
      )
        return json(200, { expires_at: options.expiresAt });
      json(404, { message: "404 Not Found" });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        host: `127.0.0.1:${port}`,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function runUp(args: string[], env: Record<string, string>) {
  try {
    const result = await execFileAsync("bash", [upSh, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${env.PATH ?? process.env.PATH}`,
        HOME: env.HOME,
        AFK_HOME: env.AFK_HOME,
        AFK_GITHUB_APP_DIR: env.AFK_GITHUB_APP_DIR,
        AFK_GITLAB_DIR: env.AFK_GITLAB_DIR,
        AFK_MODEL: env.AFK_MODEL ?? "cursor-test-model",
        CURSOR_API_KEY: env.CURSOR_API_KEY ?? "test-key",
        AFK_SANDBOX_IMAGE: "sandcastle:afk-test",
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function machine(gitlabDir: string) {
  const home = tempDir("afk-up-home-");
  const githubDir = join(home, "secrets", "github-app");
  mkdirSync(githubDir, { recursive: true });
  mkdirSync(gitlabDir, { recursive: true });
  return {
    PATH: `${stubDocker()}:${process.env.PATH}`,
    HOME: home,
    AFK_HOME: home,
    AFK_GITHUB_APP_DIR: githubDir,
    AFK_GITLAB_DIR: gitlabDir,
  };
}

describe("scripts/up.sh --check with GitLab tokens", () => {
  it("passes on a machine that has only a GitLab token, without a GitHub warning", async () => {
    const gitlab = await listenGitLabUser({
      token: TOKEN,
      username: "alice",
      expiresAt: "2026-12-09",
    });
    try {
      const gitlabDir = tempDir("afk-up-gitlab-");
      const path = join(gitlabDir, gitlab.host);
      writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      const result = await runUp(["--check"], machine(gitlabDir));
      const text = `${result.stdout}${result.stderr}`;
      expect(result.status, text).toBe(0);
      expect(result.stdout).toContain("All checks passed.");
      expect(text).toContain("alice");
      expect(text).toContain("2026-12-09");
      expect(text).not.toContain("No GitHub App credentials");
      expect(text).not.toContain("check-github-app.ts");
    } finally {
      await gitlab.stop();
    }
  });

  it("prints a chmod 600 command when the token file is mode 644", async () => {
    const gitlabDir = tempDir("afk-up-gitlab-");
    const path = join(gitlabDir, "git.example.com");
    writeFileSync(path, `${TOKEN}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    const result = await runUp(["--check"], machine(gitlabDir));
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toContain(`chmod 600 ${path}`);
  });

  it("shows why the token failed and does not pass when GitLab rejects it", async () => {
    const gitlab = await listenGitLabUser({
      token: TOKEN,
      username: "alice",
      expiresAt: "2026-12-09",
      userStatus: 401,
    });
    try {
      const gitlabDir = tempDir("afk-up-gitlab-");
      const path = join(gitlabDir, gitlab.host);
      writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      const result = await runUp(["--check"], machine(gitlabDir));
      const text = `${result.stdout}${result.stderr}`;
      expect(result.status, text).not.toBe(0);
      expect(text).toMatch(/HTTP 401|401 Unauthorized/);
      expect(text).not.toContain("All checks passed.");
    } finally {
      await gitlab.stop();
    }
  });
});

describe("scripts/up.sh with no code-host credentials", () => {
  it("fails without asking, and prints both setup commands, when stdin is not a terminal", async () => {
    const gitlabDir = tempDir("afk-up-gitlab-");
    const result = await runUp([], machine(gitlabDir));
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/private-key\.pem/);
    expect(text).toMatch(/app\.json/);
    expect(text).toMatch(/chmod 600 .*gitlab/);
    expect(text).not.toMatch(/\[Y\/n\]/);
    expect(text).not.toMatch(/\[github\/gitlab\]/i);
    expect(text).not.toContain("All checks passed.");
  });

  it("does not ask when invoked with --check", async () => {
    const gitlabDir = tempDir("afk-up-gitlab-");
    const result = await runUp(["--check"], machine(gitlabDir));
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/private-key\.pem/);
    expect(text).toMatch(/chmod 600 .*gitlab/);
    expect(text).not.toMatch(/\[github\/gitlab\]/i);
    expect(text).not.toMatch(/\[Y\/n\]/);
    expect(text).not.toContain("All checks passed.");
  });
});
