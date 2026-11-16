import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const restartSh = fileURLToPath(
  new URL("../../../scripts/restart.sh", import.meta.url),
);

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

describe("scripts/up.sh restarts a crashed API without stopping the worker", {
  timeout: 45_000,
}, () => {
  let live: ChildProcess | undefined;
  afterEach(() => {
    if (live?.pid) {
      try {
        process.kill(live.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    live = undefined;
  });

  async function waitUntil(label: string, ok: () => boolean, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  function stack(options: { api: string; worker: string; web?: string }) {
    const home = tempDir("afk-up-stack-");
    const githubDir = join(home, "secrets", "github-app");
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, "private-key.pem"), "dummy");
    writeFileSync(join(githubDir, "app.json"), "{}");
    const bin = tempDir("afk-up-stack-bin-");
    writeFileSync(
      join(bin, "docker"),
      readFileSync(join(stubDocker(), "docker")),
    );
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh
case "$1" in
  -v) echo "9.0.0"; exit 0 ;;
  api) exec "$AFK_FAKE_API" ;;
  web) exec "$AFK_FAKE_WEB" ;;
  worker) exec "$AFK_FAKE_WORKER" ;;
  *) echo "unexpected pnpm $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    const fakeApi = join(bin, "fake-api");
    const fakeWorker = join(bin, "fake-worker");
    const fakeWeb = join(bin, "fake-web");
    writeFileSync(fakeApi, `#!/bin/sh\n${options.api}\n`, { mode: 0o755 });
    writeFileSync(fakeWorker, `#!/bin/sh\n${options.worker}\n`, {
      mode: 0o755,
    });
    writeFileSync(fakeWeb, `#!/bin/sh\n${options.web ?? "exec sleep 3600"}\n`, {
      mode: 0o755,
    });
    chmodSync(fakeApi, 0o755);
    chmodSync(fakeWorker, 0o755);
    chmodSync(fakeWeb, 0o755);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      AFK_HOME: home,
      AFK_GITHUB_APP_DIR: githubDir,
      AFK_GITLAB_DIR: join(home, "secrets", "gitlab"),
      AFK_MODEL: "cursor-test-model",
      CURSOR_API_KEY: "test-key",
      AFK_SANDBOX_IMAGE: "sandcastle:afk-test",
      AFK_UP_SKIP_STACK: "1",
      WEB: "0",
      PORT: String(18000 + Math.floor(Math.random() * 1000)),
      AFK_FAKE_API: fakeApi,
      AFK_FAKE_WORKER: fakeWorker,
      AFK_FAKE_WEB: fakeWeb,
    };
    let output = "";
    const child = spawn("bash", [upSh], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    live = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    return {
      home,
      env,
      output: () => output,
      child,
    };
  }

  it("restarts the API after it exits and leaves the worker pid unchanged", async () => {
    const hold = `echo $$ > "$AFK_HOME/run-live.pid"
trap 'exit 0' INT TERM
while true; do sleep 1; done`;
    const apiOnce = `nfile="$AFK_HOME/api-starts"
n=$(($(cat "$nfile" 2>/dev/null || echo 0) + 1))
echo "$n" > "$nfile"
echo $$ > "$AFK_HOME/api-live.pid"
if [ "$n" -eq 1 ]; then exit 1; fi
${hold}`;
    const { home, output } = stack({ api: apiOnce, worker: hold });
    const workerPid = join(home, "run", "worker.pid");
    const apiStarts = join(home, "api-starts");
    await waitUntil("worker pid", () => existsSync(workerPid));
    const pid = readFileSync(workerPid, "utf8").trim();
    expect(pid).toMatch(/^\d+$/);
    await waitUntil("API restarted", () => {
      if (!existsSync(apiStarts)) return false;
      return Number(readFileSync(apiStarts, "utf8").trim()) >= 2;
    });
    expect(readFileSync(workerPid, "utf8").trim()).toBe(pid);
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    expect(output()).not.toMatch(/stopping the rest/);
  });

  it("stops restarting the API after 5 crashes in 60s and prints why", async () => {
    const hold = `echo $$ > "$AFK_HOME/run-live.pid"
trap 'exit 0' INT TERM
while true; do sleep 1; done`;
    const crash = `nfile="$AFK_HOME/api-starts"
n=$(($(cat "$nfile" 2>/dev/null || echo 0) + 1))
echo "$n" > "$nfile"
exit 1`;
    const { home, output, child } = stack({ api: crash, worker: hold });
    const workerPid = join(home, "run", "worker.pid");
    await waitUntil("worker pid", () => existsSync(workerPid));
    const pid = readFileSync(workerPid, "utf8").trim();
    await waitUntil(
      "give up restarting",
      () => /crashed 5 times in 60s/.test(output()),
      30_000,
    );
    expect(output()).toMatch(/not restarting/);
    expect(readFileSync(workerPid, "utf8").trim()).toBe(pid);
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    expect(child.exitCode).toBeNull();
  });

  it("restart.sh api replaces only the API process and leaves the worker pid unchanged", async () => {
    const hold = `echo $$ > "$AFK_HOME/run-live.pid"
trap 'exit 0' INT TERM
while true; do sleep 1; done`;
    const { home, env, output, child } = stack({ api: hold, worker: hold });
    const workerPid = join(home, "run", "worker.pid");
    const apiPid = join(home, "run", "api.pid");
    await waitUntil("pids", () => existsSync(workerPid) && existsSync(apiPid));
    const worker = readFileSync(workerPid, "utf8").trim();
    const api = readFileSync(apiPid, "utf8").trim();
    expect(worker).toMatch(/^\d+$/);
    expect(api).toMatch(/^\d+$/);
    const result = await new Promise<{
      status: number | null;
      text: string;
    }>((resolve) => {
      const proc = spawn("bash", [restartSh, "api"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      proc.on("close", (code) => resolve({ status: code, text }));
    });
    expect(result.status, `${result.text}\n${output()}`).toBe(0);
    await waitUntil("api pid changed", () => {
      if (!existsSync(apiPid)) return false;
      const next = readFileSync(apiPid, "utf8").trim();
      return next !== api && existsSync(`/proc/${next}`);
    });
    expect(readFileSync(workerPid, "utf8").trim()).toBe(worker);
    expect(existsSync(`/proc/${worker}`)).toBe(true);
    expect(existsSync(`/proc/${api}`)).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(output()).not.toMatch(/stopping the rest/);
  });

  it("restart.sh worker starts a new worker, drains the old one with SIGUSR2, and leaves the rest running", async () => {
    const hold = `echo $$ > "$AFK_HOME/run-live.pid"
trap 'exit 0' INT TERM
while true; do sleep 1; done`;
    const workerHold = `nfile="$AFK_HOME/worker-starts"
n=$(($(cat "$nfile" 2>/dev/null || echo 0) + 1))
echo "$n" > "$nfile"
echo $$ > "$AFK_HOME/worker-live.pid"
trap 'exit 0' INT TERM
trap 'echo usr2 > "$AFK_HOME/worker-usr2"; exit 0' USR2
while true; do sleep 1; done`;
    const { home, env, output, child } = stack({
      api: hold,
      worker: workerHold,
    });
    const workerPid = join(home, "run", "worker.pid");
    const apiPid = join(home, "run", "api.pid");
    await waitUntil("pids", () => existsSync(workerPid) && existsSync(apiPid));
    const oldWorker = readFileSync(workerPid, "utf8").trim();
    const api = readFileSync(apiPid, "utf8").trim();
    expect(oldWorker).toMatch(/^\d+$/);
    const result = await new Promise<{
      status: number | null;
      text: string;
    }>((resolve) => {
      const proc = spawn("bash", [restartSh, "worker"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      proc.on("close", (code) => resolve({ status: code, text }));
    });
    expect(result.status, `${result.text}\n${output()}`).toBe(0);
    await waitUntil("new worker", () => {
      if (!existsSync(workerPid)) return false;
      const next = readFileSync(workerPid, "utf8").trim();
      return next !== oldWorker && existsSync(`/proc/${next}`);
    });
    const usr2 = join(home, "worker-usr2");
    await waitUntil("old worker got SIGUSR2", () => existsSync(usr2));
    expect(readFileSync(usr2, "utf8")).toMatch(/usr2/);
    await waitUntil(
      "old worker exited",
      () => !existsSync(`/proc/${oldWorker}`),
    );
    expect(readFileSync(apiPid, "utf8").trim()).toBe(api);
    expect(existsSync(`/proc/${api}`)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(output()).not.toMatch(/stopping the rest/);
  });
});

describe("scripts/restart.sh", () => {
  async function runRestart(args: string[], env: Record<string, string>) {
    try {
      const result = await execFileAsync("bash", [restartSh, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: env.PATH ?? process.env.PATH,
          HOME: env.HOME,
          AFK_HOME: env.AFK_HOME,
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

  it("exits non-zero and says to run scripts/up.sh when up.sh is not running", async () => {
    const home = tempDir("afk-restart-none-");
    const result = await runRestart(["worker"], {
      HOME: home,
      AFK_HOME: home,
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/scripts\/up\.sh/);
  });
});

describe("restart docs", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

  it("the operations manual says a crashed API is brought back up", () => {
    const text = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    const section = text.slice(
      text.indexOf("### 1.1"),
      text.indexOf("### 1.2"),
    );
    expect(section).toMatch(/API/);
    expect(section).toMatch(/自动拉起|重新拉起/);
  });

  it("the operations manual tells how to restart without losing work, and that Ctrl-C abandons jobs", () => {
    const text = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    const section = text.slice(
      text.indexOf("### 1.1"),
      text.indexOf("### 1.2"),
    );
    expect(section).toMatch(/scripts\/restart\.sh api/);
    expect(section).toMatch(/scripts\/restart\.sh web/);
    expect(section).toMatch(/scripts\/restart\.sh worker/);
    expect(section).toMatch(/Ctrl-C/);
    expect(section).toMatch(/放弃/);
  });

  it("the operations manual restarts the worker with restart.sh, not up.sh", () => {
    const text = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    const section9 = text.slice(text.indexOf("## 9."), text.indexOf("## 附录"));
    expect(section9).toMatch(/scripts\/restart\.sh worker/);
    expect(section9).not.toMatch(/scripts\/up\.sh.*重启/);
    expect(text).not.toMatch(/改了 worker 就用 `scripts\/up\.sh` 重启/);
  });

  it("the design says the worker keeps a job when it cannot reach the API, and the API renews leases at start", () => {
    const text = readFileSync(join(repoRoot, "docs/design.md"), "utf8");
    expect(text).toMatch(/连不上 API 时不放弃作业/);
    expect(text).toMatch(/API 启动时.*续.*租约/);
  });

  it("the design describes draining on SIGUSR2 and rolling worker restart", () => {
    const text = readFileSync(join(repoRoot, "docs/design.md"), "utf8");
    expect(text).toMatch(/SIGUSR2/);
    expect(text).toMatch(/排空/);
    expect(text).toMatch(/滚动重启|scripts\/restart\.sh worker/);
  });

  it("CLAUDE.md restarts worker and API with restart.sh, not up.sh", () => {
    const text = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const section = text.slice(
      text.indexOf("## 本机平台栈"),
      text.indexOf("## 在这个仓库里规划"),
    );
    expect(section).toMatch(/scripts\/restart\.sh worker/);
    expect(section).toMatch(/scripts\/restart\.sh api/);
    expect(section).not.toMatch(
      /改 `packages\/pipeline\/skills` 或 pipeline 后 \*\*重启 worker\*\*（`scripts\/up\.sh`）/,
    );
  });

  it("optimization plan 8.15 records the restart waste and what this spec did not do", () => {
    const text = readFileSync(
      join(repoRoot, "docs/optimization-plan.md"),
      "utf8",
    );
    expect(text).toMatch(/### 8\.15/);
    expect(text).toContain("T-97");
    expect(text).toContain("T-99");
    expect(text).toContain("16.5");
    expect(text).toContain("571");
    expect(text).toContain("574");
    expect(text).toContain("575");
    expect(text).toContain("lease-expired");
    expect(text).toMatch(/worker 崩溃后接管容器/);
    expect(text).toContain("Sandcastle 0.12");
  });
});
