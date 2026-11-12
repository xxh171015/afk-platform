import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StructuredOutputError } from "@ai-hero/sandcastle";
import { afterEach, describe, expect, it } from "vitest";
import { runE2e } from "./e2e.ts";
import { gitOut } from "./exec.ts";
import { runGate } from "./gate.ts";
import {
  agentEnv,
  classifyAgentError,
  DEPS_CACHE_SANDBOX_PATH,
  SANDBOX_SKILLS_DIR,
  type SandboxDocker,
  type SandcastleConfig,
  SandcastleGateSandbox,
  sandboxMounts,
  sandboxProvider,
} from "./sandcastle.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

// What can be checked without Docker: the configuration handed to Sandcastle, how its errors are read, and
// that Sandcastle stays behind this one module. The real thing is exercised by the interruption drill (#42).

describe("the mounts", () => {
  it("gives the agent /context and the skills, both read-only", () => {
    expect(
      sandboxMounts({ ctxDir: "/host/ctx", skillsMount: "/host/skills" }),
    ).toEqual([
      { hostPath: "/host/ctx", sandboxPath: "/context", readonly: true },
      {
        hostPath: "/host/skills",
        sandboxPath: "/home/agent/.cursor/skills",
        readonly: true,
      },
    ]);
  });

  it("mounts each snapshot of a repo the ticket refs read-only at /refs/<repo>, and nothing when it refs none", () => {
    const refs = [
      { name: "backend", dir: "/snap/backend@abc" },
      { name: "payments", dir: "/snap/payments@def" },
    ];
    expect(
      sandboxMounts({ ctxDir: "/c", skillsMount: "/s", refs }).slice(1, 3),
    ).toEqual([
      {
        hostPath: "/snap/backend@abc",
        sandboxPath: "/refs/backend",
        readonly: true,
      },
      {
        hostPath: "/snap/payments@def",
        sandboxPath: "/refs/payments",
        readonly: true,
      },
    ]);
    expect(
      sandboxMounts({ ctxDir: "/c", skillsMount: "/s" }).map(
        (m) => m.sandboxPath,
      ),
    ).toEqual(["/context", "/home/agent/.cursor/skills"]);
  });

  it("gives the gate sandbox no /context", () => {
    expect(sandboxMounts({ skillsMount: "/host/skills" })).toEqual([
      {
        hostPath: "/host/skills",
        sandboxPath: "/home/agent/.cursor/skills",
        readonly: true,
      },
    ]);
  });

  it("never mounts anything writable", () => {
    for (const mount of sandboxMounts({
      ctxDir: "/c",
      skillsMount: "/s",
      refs: [{ name: "backend", dir: "/r" }],
    })) {
      expect(mount.readonly).toBe(true);
    }
  });
});

describe("the environment", () => {
  it("is the Cursor API key and nothing else", () => {
    expect(agentEnv("key-123")).toEqual({ CURSOR_API_KEY: "key-123" });
  });
});

// A docker that only writes down what it is asked, the same shape leftover cleanup uses.
function recordingDocker() {
  const calls: string[][] = [];
  const docker: SandboxDocker = (args) => {
    calls.push(args);
    return { code: 0, stdout: "ok\n" };
  };
  return { docker, calls };
}

const dockerRunOf = (calls: string[][]) => {
  const run = calls.find((call) => call[0] === "run");
  expect(run, "docker run was not recorded").toBeDefined();
  return run as string[];
};

const defaultCreate = {
  worktreePath: "/host/wt",
  hostRepoPath: "/host/repo",
  mounts: [{ hostPath: "/host/wt", sandboxPath: "/home/agent/workspace" }],
  env: {},
};

type CreatedSandbox = {
  exec(
    command: string,
    options?: {
      cwd?: string;
      stdin?: string;
      onLine?: (line: string) => void;
      sudo?: boolean;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  close(): Promise<void>;
};

// Sandcastle keeps provider.create off the public type; the runtime object still has it.
function startProvider(
  options: Parameters<typeof sandboxProvider>[0],
  create = defaultCreate,
) {
  const provider = sandboxProvider(options) as unknown as {
    create: (opts: typeof defaultCreate) => Promise<CreatedSandbox>;
  };
  return provider.create(create);
}

function oomDocker(opts: { execCode: number; oomKilled: boolean }) {
  const calls: string[][] = [];
  const docker: SandboxDocker = (args) => {
    calls.push(args);
    if (args[0] === "exec") return { code: opts.execCode, stdout: "killed\n" };
    if (args[0] === "inspect")
      return { code: 0, stdout: opts.oomKilled ? "true\n" : "false\n" };
    return { code: 0, stdout: "ok\n" };
  };
  return { docker, calls };
}

function expectHardened(args: string[], kind: "agent" | "gate", runId = "R-9") {
  expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL"]));
  expect(args).toEqual(
    expect.arrayContaining(["--security-opt", "no-new-privileges=true"]),
  );
  expect(args).toContain("--init");
  expect(args).toEqual(expect.arrayContaining(["--pids-limit", "4096"]));
  expect(args).toEqual(expect.arrayContaining(["--memory", "3g"]));
  expect(args).toEqual(expect.arrayContaining(["--memory-swap", "3g"]));
  expect(args).toEqual(expect.arrayContaining(["--cpus", "2"]));
  expect(args).toEqual(expect.arrayContaining(["--shm-size", "1g"]));
  expect(args).toEqual(expect.arrayContaining(["--label", `afk.run=${runId}`]));
  expect(args).toEqual(expect.arrayContaining(["--label", `afk.kind=${kind}`]));
}

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

function gateConfig(
  fake: ReturnType<typeof recordingDocker>,
  over: Partial<SandcastleConfig> = {},
): SandcastleConfig {
  const logDir = mkdtempSync(join(tmpdir(), "afk-sandbox-log-"));
  return {
    cwd: repo?.dir as string,
    image: "sandcastle:afk-platform",
    model: "m",
    skillsMount: SANDBOX_SKILLS_DIR,
    cursorApiKey: "k",
    logDir,
    runId: "R-9",
    docker: fake.docker,
    ...over,
  };
}

describe("the hardened sandbox", () => {
  it("records a docker run that drops all capabilities, cannot gain new ones, has init, limits pids, memory, swap, cpus and shm, and is labelled with the run and kind", async () => {
    const fake = recordingDocker();
    await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({ skillsMount: SANDBOX_SKILLS_DIR }),
      kind: "gate",
      runId: "R-9",
      docker: fake.docker,
    });
    const run = dockerRunOf(fake.calls);
    expect(run).toEqual(expect.arrayContaining(["--cap-drop", "ALL"]));
    expect(run).toEqual(
      expect.arrayContaining(["--security-opt", "no-new-privileges=true"]),
    );
    expect(run).toContain("--init");
    expect(run).toEqual(expect.arrayContaining(["--pids-limit", "4096"]));
    expect(run).toEqual(expect.arrayContaining(["--memory", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--memory-swap", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--cpus", "2"]));
    expect(run).toEqual(expect.arrayContaining(["--shm-size", "1g"]));
    expect(run).toEqual(expect.arrayContaining(["--label", "afk.run=R-9"]));
    expect(run).toEqual(expect.arrayContaining(["--label", "afk.kind=gate"]));
  });

  it("uses the same hardened docker run for an agent sandbox, labelled agent rather than gate", async () => {
    const fake = recordingDocker();
    await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({
        ctxDir: SANDBOX_SKILLS_DIR,
        skillsMount: SANDBOX_SKILLS_DIR,
      }),
      kind: "agent",
      runId: "R-9",
      docker: fake.docker,
    });
    const run = dockerRunOf(fake.calls);
    expect(run).toEqual(expect.arrayContaining(["--cap-drop", "ALL"]));
    expect(run).toEqual(
      expect.arrayContaining(["--security-opt", "no-new-privileges=true"]),
    );
    expect(run).toContain("--init");
    expect(run).toEqual(expect.arrayContaining(["--pids-limit", "4096"]));
    expect(run).toEqual(expect.arrayContaining(["--memory", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--memory-swap", "3g"]));
    expect(run).toEqual(expect.arrayContaining(["--cpus", "2"]));
    expect(run).toEqual(expect.arrayContaining(["--shm-size", "1g"]));
    expect(run).toEqual(expect.arrayContaining(["--label", "afk.run=R-9"]));
    expect(run).toEqual(expect.arrayContaining(["--label", "afk.kind=agent"]));
    expect(run).not.toEqual(
      expect.arrayContaining(["--label", "afk.kind=gate"]),
    );
  });

  it("the ticket gate opens a Sandcastle sandbox with those docker run parameters", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        'setup: "true"\ncommands:\n  - { name: test, run: "true", timeoutSeconds: 30 }\n',
    });
    const sha = gitOut(repo.dir, ["rev-parse", "main"]);
    gitOut(repo.dir, ["branch", "agent/T-1", sha]);
    const fake = recordingDocker();
    await runGate({
      repoDir: repo.dir,
      sandbox: new SandcastleGateSandbox(gateConfig(fake)),
      ref: "agent/T-1",
      commitSha: sha,
      configSha: sha,
    });
    expectHardened(dockerRunOf(fake.calls), "gate");
  });

  it("the e2e path opens a Sandcastle sandbox with those same docker run parameters", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        'setup: "true"\ncommands:\n  - { name: test, run: "true", timeoutSeconds: 30 }\n',
    });
    const sha = gitOut(repo.dir, ["rev-parse", "main"]);
    gitOut(repo.dir, ["branch", "e2e/T-1", sha]);
    const fake = recordingDocker();
    await runE2e({
      repoDir: repo.dir,
      sandbox: new SandcastleGateSandbox(gateConfig(fake)),
      ref: "e2e/T-1",
      commitSha: sha,
      configSha: sha,
      network: "afk-r-9_default",
      env: { BACKEND_URL: "http://backend:8080" },
    });
    const run = dockerRunOf(fake.calls);
    expectHardened(run, "gate");
    expect(run).toEqual(
      expect.arrayContaining(["--network", "afk-r-9_default"]),
    );
  });

  it("takes memory, pids, cpus and shm from the limits it is given, not only the defaults", async () => {
    const fake = recordingDocker();
    await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({ skillsMount: SANDBOX_SKILLS_DIR }),
      kind: "gate",
      runId: "R-9",
      limits: { memory: "1g", pids: 256, cpus: 0.5, shmSize: "64m" },
      docker: fake.docker,
    });
    const run = dockerRunOf(fake.calls);
    expect(run).toEqual(expect.arrayContaining(["--pids-limit", "256"]));
    expect(run).toEqual(expect.arrayContaining(["--memory", "1g"]));
    expect(run).toEqual(expect.arrayContaining(["--memory-swap", "1g"]));
    expect(run).toEqual(expect.arrayContaining(["--cpus", "0.5"]));
    expect(run).toEqual(expect.arrayContaining(["--shm-size", "64m"]));
  });

  it("keeps the worktree and skills mounts, the container user, HOME, and the compose network", async () => {
    const fake = recordingDocker();
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    await startProvider(
      {
        image: "sandcastle:afk-platform",
        mounts: sandboxMounts({
          ctxDir: SANDBOX_SKILLS_DIR,
          skillsMount: SANDBOX_SKILLS_DIR,
        }),
        env: { AFK_NPM_REGISTRIES: "https://example.invalid" },
        network: "afk-r-9_default",
        kind: "agent",
        runId: "R-9",
        docker: fake.docker,
      },
      { ...defaultCreate, env: { BACKEND_URL: "http://backend:8080" } },
    );
    const run = dockerRunOf(fake.calls);
    expect(run).toEqual(expect.arrayContaining(["--user", `${uid}:${gid}`]));
    expect(run).toEqual(expect.arrayContaining(["-e", "HOME=/home/agent"]));
    expect(run).toEqual(
      expect.arrayContaining(["-e", "BACKEND_URL=http://backend:8080"]),
    );
    expect(run).toEqual(
      expect.arrayContaining([
        "-e",
        "AFK_NPM_REGISTRIES=https://example.invalid",
      ]),
    );
    expect(run).toEqual(
      expect.arrayContaining(["--network", "afk-r-9_default"]),
    );
    const volumes = run.flatMap((arg, i) => (run[i - 1] === "-v" ? [arg] : []));
    expect(
      volumes.some((v) => v.startsWith("/host/wt:/home/agent/workspace")),
    ).toBe(true);
    expect(
      volumes.some((v) =>
        v.includes(`${SANDBOX_SKILLS_DIR}:/home/agent/.cursor/skills:ro`),
      ),
    ).toBe(true);
    expect(
      volumes.some((v) => v.includes(`${SANDBOX_SKILLS_DIR}:/context:ro`)),
    ).toBe(true);
  });
});

describe("the gate's dependency cache", () => {
  const gateRepo = () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        'setup: "true"\ncommands:\n  - { name: test, run: "true", timeoutSeconds: 30 }\n',
    });
    const sha = gitOut(repo.dir, ["rev-parse", "main"]);
    gitOut(repo.dir, ["branch", "agent/T-1", sha]);
    return sha;
  };
  const volumesOf = (run: string[]) =>
    run.flatMap((arg, i) => (run[i - 1] === "-v" ? [arg] : []));

  it("mounts the repo's cache folder writable and points the package managers at it, so a second gate downloads nothing", async () => {
    const sha = gateRepo();
    const cache = join(mkdtempSync(join(tmpdir(), "afk-deps-")), "backend");
    const fake = recordingDocker();
    await runGate({
      repoDir: repo?.dir as string,
      sandbox: new SandcastleGateSandbox(
        gateConfig(fake, { depsCacheDir: cache }),
      ),
      ref: "agent/T-1",
      commitSha: sha,
      configSha: sha,
    });
    const run = dockerRunOf(fake.calls);
    expect(volumesOf(run)).toContain(`${cache}:${DEPS_CACHE_SANDBOX_PATH}:z`);
    expect(run).toEqual(
      expect.arrayContaining([
        "-e",
        `pnpm_config_store_dir=${DEPS_CACHE_SANDBOX_PATH}/pnpm-store`,
      ]),
    );
    expect(run).toEqual(
      expect.arrayContaining([
        "-e",
        `pnpm_config_cache_dir=${DEPS_CACHE_SANDBOX_PATH}/pnpm-cache`,
      ]),
    );
    expect(run).toEqual(
      expect.arrayContaining([
        "-e",
        `AFK_DEPS_CACHE=${DEPS_CACHE_SANDBOX_PATH}`,
      ]),
    );
    // made before docker run, so the container's user owns it rather than docker making it as root
    expect(statSync(cache).isDirectory()).toBe(true);
  });

  it("is not there when the worker gives no cache folder", async () => {
    const sha = gateRepo();
    const fake = recordingDocker();
    await runGate({
      repoDir: repo?.dir as string,
      sandbox: new SandcastleGateSandbox(gateConfig(fake)),
      ref: "agent/T-1",
      commitSha: sha,
      configSha: sha,
    });
    const run = dockerRunOf(fake.calls);
    expect(
      volumesOf(run).some((v) => v.includes(DEPS_CACHE_SANDBOX_PATH)),
    ).toBe(false);
    expect(run.some((arg) => arg.startsWith("AFK_DEPS_CACHE="))).toBe(false);
  });
});

describe("a sandbox that ran out of memory", () => {
  it("maps inspect OOMKilled after a failed exec to sandbox-oom", async () => {
    const fake = oomDocker({ execCode: 137, oomKilled: true });
    const sandbox = await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({ skillsMount: SANDBOX_SKILLS_DIR }),
      kind: "gate",
      runId: "R-9",
      docker: fake.docker,
    });
    await expect(sandbox.exec("hog")).rejects.toThrow(/sandbox-oom/);
    expect(fake.calls.some((call) => call[0] === "inspect")).toBe(true);
    expect(
      fake.calls.some((call) => call.includes("{{.State.OOMKilled}}")),
    ).toBe(true);
  });

  it("maps inspect OOMKilled before close to sandbox-oom", async () => {
    const fake = oomDocker({ execCode: 0, oomKilled: true });
    const sandbox = await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({ skillsMount: SANDBOX_SKILLS_DIR }),
      kind: "gate",
      runId: "R-9",
      docker: fake.docker,
    });
    await expect(sandbox.close()).rejects.toThrow(/sandbox-oom/);
    const inspectAt = fake.calls.findIndex((call) => call[0] === "inspect");
    const stopAt = fake.calls.findIndex((call) => call[0] === "stop");
    expect(inspectAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(inspectAt);
  });

  it("a failed exec that was not OOMKilled is still a failed command", async () => {
    const fake = oomDocker({ execCode: 1, oomKilled: false });
    const sandbox = await startProvider({
      image: "sandcastle:afk-platform",
      mounts: sandboxMounts({ skillsMount: SANDBOX_SKILLS_DIR }),
      kind: "gate",
      runId: "R-9",
      docker: fake.docker,
    });
    expect(await sandbox.exec("false")).toMatchObject({ exitCode: 1 });
  });
});

describe("reading Sandcastle's errors", () => {
  it("unusable structured output is invalid-output, and keeps the commits the run made", () => {
    const error = new StructuredOutputError("bad result", {
      tag: "result",
      rawMatched: "{",
      cause: new Error("json"),
      commits: [{ sha: "abc" }, { sha: "def" }],
      branch: "agent/T-1",
    });
    expect(classifyAgentError(error)).toMatchObject({
      errorKind: "invalid-output",
      commits: ["abc", "def"],
    });
  });

  it("the wall-clock abort and an idle timeout are timeouts", () => {
    expect(classifyAgentError(new Error("wall-clock")).errorKind).toBe(
      "timeout",
    );
    const idle = new Error("agent produced no output");
    idle.name = "IdleTimeoutError";
    expect(classifyAgentError(idle).errorKind).toBe("timeout");
  });

  it("anything else is an infrastructure problem, not the ticket's fault", () => {
    expect(
      classifyAgentError(new Error("docker daemon not running")),
    ).toMatchObject({
      errorKind: "other",
      commits: [],
    });
    expect(classifyAgentError("a string").errorKind).toBe("other");
  });
});

describe("Sandcastle stays behind one module, at one version", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules") return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("is imported by sandcastle.ts and nowhere else", () => {
    const importers = sources(packages).filter((file) =>
      /from\s+["']@ai-hero\/sandcastle/.test(readFileSync(file, "utf8")),
    );
    expect(importers.map((file) => file.slice(packages.length)).sort()).toEqual(
      ["pipeline/src/sandcastle.test.ts", "pipeline/src/sandcastle.ts"],
    );
  });

  it("is pinned to exactly 0.12.0", () => {
    const manifest = JSON.parse(
      readFileSync(join(packages, "pipeline", "package.json"), "utf8"),
    );
    expect(manifest.dependencies["@ai-hero/sandcastle"]).toBe("0.12.0");
  });

  it("the gate sandbox still times commands with GNU timeout inside the image", () => {
    const src = readFileSync(
      join(packages, "pipeline", "src", "sandcastle.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /timeout \$\{options\.timeoutSeconds\} sh -c \$\{shellQuote\(command\)\}/,
    );
  });
});
