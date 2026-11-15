import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const canarySh = join(repoRoot, "scripts/canary.sh");
const canaryDir = join(repoRoot, "docs/canary");

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

async function runCanary(args: string[], env: Record<string, string> = {}) {
  try {
    const result = await execFileAsync("bash", [canarySh, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: env.PATH ?? process.env.PATH,
        HOME: env.HOME ?? process.env.HOME,
        CANARY_FAKE: env.CANARY_FAKE,
        CANARY_STAMP: env.CANARY_STAMP,
        CANARY_POLL_SECONDS: env.CANARY_POLL_SECONDS ?? "0",
        CANARY_TIMEOUT_SECONDS: env.CANARY_TIMEOUT_SECONDS ?? "2",
        CANARY_CLEANUP_SECONDS: env.CANARY_CLEANUP_SECONDS ?? "0",
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

const FAKE_PLAT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.CANARY_FAKE;
if (!dir) {
  console.error("CANARY_FAKE is not set");
  process.exit(1);
}
fs.appendFileSync(
  path.join(dir, "log"),
  process.argv.slice(2).join(" ") + "\\n",
);
const args = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--json") continue;
  if (a === "--api-url") {
    i++;
    continue;
  }
  if (typeof a === "string" && a.startsWith("--api-url=")) continue;
  args.push(a);
}
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "cfg.json"), "utf8"));
const reply = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\\n");
};
const [cmd, sub, ...rest] = args;
if (cmd === "project" && sub === "show") {
  reply(cfg.project);
  process.exit(0);
}
if (cmd === "spec" && sub === "create") {
  reply(cfg.specCreate);
  process.exit(0);
}
if (cmd === "tickets" && sub === "import") {
  const spec = rest[0];
  const ticketsDir = rest[1];
  fs.cpSync(ticketsDir, path.join(dir, "imported"), { recursive: true });
  fs.writeFileSync(path.join(dir, "import-spec"), spec ?? "");
  reply(cfg.imported);
  process.exit(0);
}
if (cmd === "spec" && sub === "confirm") {
  reply(cfg.confirm);
  process.exit(0);
}
if (cmd === "spec" && sub === "show") {
  const iPath = path.join(dir, "show-i");
  let i = 0;
  try {
    i = Number(fs.readFileSync(iPath, "utf8"));
  } catch {}
  const shows = cfg.shows;
  const view = shows[Math.min(i, shows.length - 1)];
  fs.writeFileSync(iPath, String(i + 1));
  reply(view);
  process.exit(0);
}
if (cmd === "ticket" && sub === "view") {
  const id = rest[0];
  const view = cfg.ticketViews[id];
  if (!view) {
    console.error("no ticket " + id);
    process.exit(1);
  }
  reply(view);
  process.exit(0);
}
if (cmd === "run" && sub === "show") {
  const id = rest[0];
  const view = cfg.runViews[id];
  if (!view) {
    console.error("no run " + id);
    process.exit(1);
  }
  reply(view);
  process.exit(0);
}
if (cmd === "spec" && sub === "cancel") {
  fs.writeFileSync(path.join(dir, "cancelled"), rest[0] ?? "");
  reply(cfg.cancel);
  process.exit(0);
}
console.error("unexpected plat " + args.join(" "));
process.exit(1);
`;

const FAKE_GIT = `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  cat "$CANARY_FAKE/ls-remote"
  exit 0
fi
echo "unexpected git $*" >&2
exit 1
`;

const FAKE_PSQL = `#!/bin/sh
echo "psql should not be called: $*" >&2
exit 1
`;

function specShow(
  overrides: {
    state?: string;
    pauseReason?: string | null;
    tickets?: unknown[];
    usageByStage?: unknown[];
    pullRequests?: unknown[];
    integrationBranches?: unknown[];
    finalizations?: unknown[];
    cleanup?: { state: string } | null;
  } = {},
) {
  return {
    spec: {
      id: 1,
      displayId: "S-1",
      slug: "canary-stamp",
      state: overrides.state ?? "running",
      pauseReason: overrides.pauseReason ?? null,
      integrationBranches: overrides.integrationBranches ?? [
        {
          repoId: 1,
          branch: "spec/abc123/canary-stamp",
          name: "afk-platform",
          url: "git@github.com:example/afk-platform.git",
          hostKind: "github",
        },
      ],
    },
    tickets: overrides.tickets ?? [
      {
        displayId: "T-1",
        state: "running",
        blockedReason: null,
        repo: "afk-platform",
      },
    ],
    usageByStage: overrides.usageByStage ?? [
      {
        stage: "implement",
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 1,
      },
    ],
    pullRequests: overrides.pullRequests ?? [],
    finalizations: overrides.finalizations ?? [],
    cleanup: overrides.cleanup ?? null,
  };
}

function successCfg() {
  const done = specShow({
    state: "finalizing",
    tickets: [
      {
        displayId: "T-1",
        state: "done",
        blockedReason: null,
        repo: "afk-platform",
      },
    ],
  });
  return {
    project: {
      id: 1,
      name: "afk-platform",
      repos: [
        {
          name: "afk-platform",
          url: "git@github.com:example/afk-platform.git",
          defaultBranch: "main",
          contractPath: null,
          hostKind: "github",
        },
      ],
    },
    specCreate: { id: 1, displayId: "S-1" },
    imported: {
      tickets: [{ key: "stamp", id: 1, displayId: "T-1" }],
      warnings: [],
    },
    confirm: {
      state: "running",
      integrationBranches: [{ repoId: 1, branch: "spec/abc123/canary-stamp" }],
      enqueued: [{ ticketId: 1, displayId: "T-1", jobId: 1 }],
      planningRepo: "afk-platform",
      planningState: "committed",
    },
    shows: [specShow(), done],
    ticketViews: {
      "T-1": {
        ticket: { displayId: "T-1", state: "done", blockedReason: null },
        runs: [
          { displayId: "R-1", stage: "implement", result: "done" },
          { displayId: "R-2", stage: "gate", result: "passed" },
        ],
        gateResults: [
          {
            kind: "gate",
            commitSha: "abc",
            configSha: "cfg",
            commandResults: [],
            testsTotal: 3,
            testsSkipped: 0,
            testCases: [
              {
                name: "writes the stamp",
                classname: "canary",
                status: "passed",
              },
            ],
          },
        ],
      },
    } as Record<string, unknown>,
    runViews: {
      "R-1": {
        displayId: "R-1",
        stage: "implement",
        tokenUsage: { inputTokens: 10, outputTokens: 4 },
        output: {
          status: "done",
          decisions: [{ kind: "choice", text: "wrote the stamp file" }],
        },
      },
    } as Record<string, unknown>,
    cancel: { state: "cancelled", cancelled: ["T-1"], pullRequests: [] },
  };
}

function stubBins(cfg: unknown, lsRemote = "") {
  const fake = tempDir("afk-canary-fake-");
  writeFileSync(join(fake, "cfg.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  writeFileSync(join(fake, "ls-remote"), lsRemote);
  const bin = tempDir("afk-canary-bin-");
  writeFileSync(join(bin, "plat"), FAKE_PLAT, { mode: 0o755 });
  chmodSync(join(bin, "plat"), 0o755);
  writeFileSync(join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(bin, "psql"), FAKE_PSQL, { mode: 0o755 });
  chmodSync(join(bin, "psql"), 0o755);
  return { fake, bin };
}

function importedTicket(fake: string): string {
  const dir = join(fake, "imported");
  const name = readdirSync(dir).find((file) => file.endsWith(".md"));
  if (!name) throw new Error("no imported ticket");
  return readFileSync(join(dir, name), "utf8");
}

function platLog(fake: string): string {
  try {
    return readFileSync(join(fake, "log"), "utf8");
  } catch {
    return "";
  }
}

describe("scripts/canary.sh arguments", () => {
  it("prints usage and exits non-zero when --project is missing", async () => {
    const result = await runCanary([]);
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/usage:/i);
    expect(text).toMatch(/--project/);
  });
});

describe("the canary directory", () => {
  it("keeps a fixed ticket template and the file that ticket edits", () => {
    expect(existsSync(join(canaryDir, "ticket.md"))).toBe(true);
    expect(existsSync(join(canaryDir, "stamp.txt"))).toBe(true);
    const ticket = readFileSync(join(canaryDir, "ticket.md"), "utf8");
    expect(ticket).toMatch(/^---\n/);
    expect(ticket).toContain("## What to build");
    expect(ticket).toContain("## Acceptance criteria");
    expect(ticket).toMatch(/stamp\.txt/);
  });

  it("generates ticket bodies that differ only by a datetime stamp", async () => {
    const run = async (stamp: string) => {
      const { fake, bin } = stubBins(successCfg());
      const result = await runCanary(["--project", "1"], {
        PATH: `${bin}:${process.env.PATH}`,
        CANARY_FAKE: fake,
        CANARY_STAMP: stamp,
        HOME: tempDir("afk-canary-home-"),
      });
      return { result, fake };
    };
    const a = await run("2026-01-01T00:00:00Z");
    const b = await run("2026-01-02T12:30:00Z");
    const ticketA = importedTicket(a.fake);
    const ticketB = importedTicket(b.fake);
    expect(ticketA).toContain("2026-01-01T00:00:00Z");
    expect(ticketB).toContain("2026-01-02T12:30:00Z");
    expect(ticketA.replaceAll("2026-01-01T00:00:00Z", "STAMP")).toBe(
      ticketB.replaceAll("2026-01-02T12:30:00Z", "STAMP"),
    );
    expect(ticketA).toContain("## Parent\n\nS-1\n");
    expect(ticketA).toMatch(/^repo: afk-platform$/m);
  });
});

describe("scripts/canary.sh with a fake plat", () => {
  it("waits until tickets are done, prints each check, cancels, and finds no leftover branches or pull requests", async () => {
    const { fake, bin } = stubBins(successCfg());
    const result = await runCanary(
      ["--project", "1", "--api-url", "http://plat.test"],
      {
        PATH: `${bin}:${process.env.PATH}`,
        CANARY_FAKE: fake,
        CANARY_STAMP: "2026-01-01T00:00:00Z",
        HOME: tempDir("afk-canary-home-"),
      },
    );
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).toBe(0);
    expect(text).toMatch(/token usage:\s*pass/i);
    expect(text).toMatch(/decisions:\s*pass/i);
    expect(text).toMatch(/test names:\s*pass/i);
    expect(readFileSync(join(fake, "cancelled"), "utf8")).toBe("S-1");
    const log = platLog(fake);
    expect(log).toMatch(/spec create/);
    expect(log).toMatch(/tickets import S-1 /);
    expect(log).toMatch(/spec confirm S-1/);
    expect(log).toMatch(/spec show S-1/);
    expect(log).toMatch(/ticket view T-1/);
    expect(log).toMatch(/run show R-1/);
    expect(log).toMatch(/spec cancel S-1/);
    const platLines = log.split("\n").filter((line) => line.trim() !== "");
    expect(platLines.length).toBeGreaterThan(0);
    expect(platLines.every((line) => line.startsWith("--json "))).toBe(true);
    expect(log).not.toMatch(
      /spec confirm S-1[\s\S]*spec cancel S-1[\s\S]*spec confirm/,
    );
    expect(log).not.toContain("psql");
  });

  it("waits for awaiting-review when --through-final is set", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        state: "finalizing",
        tickets: [
          {
            displayId: "T-1",
            state: "done",
            blockedReason: null,
            repo: "afk-platform",
          },
        ],
      }),
      specShow({
        state: "awaiting-review",
        tickets: [
          {
            displayId: "T-1",
            state: "done",
            blockedReason: null,
            repo: "afk-platform",
          },
        ],
      }),
    ];
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1", "--through-final"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).toBe(0);
    const beforeCancel = platLog(fake).split("spec cancel")[0] ?? "";
    const shows = beforeCancel.match(/spec show S-1/g) ?? [];
    expect(shows.length).toBeGreaterThanOrEqual(2);
  });

  it("prints the blocked reason, cancels the spec, and exits non-zero", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        tickets: [
          {
            displayId: "T-1",
            state: "blocked",
            blockedReason: "gate-failed",
            repo: "afk-platform",
          },
        ],
      }),
    ];
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toContain("gate-failed");
    expect(readFileSync(join(fake, "cancelled"), "utf8")).toBe("S-1");
    expect(text).not.toMatch(/token usage:\s*pass/i);
  });

  it("prints the pause reason, cancels the spec, and exits non-zero", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        state: "paused",
        pauseReason: "budget-exhausted",
      }),
    ];
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toContain("budget-exhausted");
    expect(readFileSync(join(fake, "cancelled"), "utf8")).toBe("S-1");
  });

  it("prints each check and exits non-zero when token usage, decisions or test names are missing", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        state: "finalizing",
        tickets: [
          {
            displayId: "T-1",
            state: "done",
            blockedReason: null,
            repo: "afk-platform",
          },
        ],
        usageByStage: [],
      }),
    ];
    cfg.ticketViews["T-1"] = {
      ticket: { displayId: "T-1", state: "done", blockedReason: null },
      runs: [{ displayId: "R-1", stage: "implement", result: "done" }],
      gateResults: [
        {
          kind: "gate",
          commitSha: "abc",
          configSha: "cfg",
          commandResults: [],
          testsTotal: 3,
          testsSkipped: 0,
        },
      ],
    };
    cfg.runViews["R-1"] = {
      displayId: "R-1",
      stage: "implement",
      tokenUsage: null,
      output: { status: "done" },
    };
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/token usage:\s*fail/i);
    expect(text).toMatch(/decisions:\s*fail/i);
    expect(text).toMatch(/test names:\s*fail/i);
    expect(readFileSync(join(fake, "cancelled"), "utf8")).toBe("S-1");
  });

  it("prints leftover spec or agent branches and open pull requests and exits non-zero", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        state: "finalizing",
        tickets: [
          {
            displayId: "T-1",
            state: "done",
            blockedReason: null,
            repo: "afk-platform",
          },
        ],
        pullRequests: [
          {
            repo: "afk-platform",
            number: 9,
            url: "https://github.com/example/afk-platform/pull/9",
            state: "open",
          },
        ],
      }),
    ];
    const { fake, bin } = stubBins(
      cfg,
      "00dead refs/heads/spec/abc123/canary-stamp\n00beef refs/heads/agent/abc123/T-1\n",
    );
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/leftover:.*#9/);
    expect(text).toMatch(/leftover:.*spec\/abc123\/canary-stamp/);
    expect(text).toMatch(/leftover:.*agent\/abc123\/T-1/);
  });

  it("waits until the spec's cleanup job is done before treating leftover as gone", async () => {
    const doneTickets = [
      {
        displayId: "T-1",
        state: "done",
        blockedReason: null,
        repo: "afk-platform",
      },
    ];
    const cfg = successCfg();
    cfg.shows = [
      specShow(),
      specShow({
        state: "finalizing",
        tickets: doneTickets,
      }),
      specShow({
        state: "cancelled",
        tickets: doneTickets,
        cleanup: { state: "queued" },
      }),
      specShow({
        state: "cancelled",
        tickets: doneTickets,
        cleanup: { state: "done" },
      }),
    ];
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      CANARY_CLEANUP_SECONDS: "2",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).toBe(0);
    expect(text).not.toMatch(/leftover:/);
    const afterCancel = platLog(fake).split("spec cancel")[1] ?? "";
    expect(
      afterCancel.match(/spec show S-1/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reports leftover after the wait limit while the cleanup job is still queued", async () => {
    const cfg = successCfg();
    cfg.shows = [
      specShow({
        state: "finalizing",
        tickets: [
          {
            displayId: "T-1",
            state: "done",
            blockedReason: null,
            repo: "afk-platform",
          },
        ],
        pullRequests: [
          {
            repo: "afk-platform",
            number: 9,
            url: "https://github.com/example/afk-platform/pull/9",
            state: "open",
          },
        ],
        cleanup: { state: "queued" },
      }),
    ];
    const { fake, bin } = stubBins(cfg);
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).not.toBe(0);
    expect(text).toMatch(/leftover:.*#9/);
  });

  it("does not treat other specs' spec or agent branches as leftover", async () => {
    const { fake, bin } = stubBins(
      successCfg(),
      `${[
        "00aaaa refs/heads/spec/abc123/other-slug",
        "00bbbb refs/heads/agent/abc123/T-99",
        "00cccc refs/heads/spec/def456/elsewhere",
        "00dddd refs/heads/agent/def456/T-1",
        "00eeee refs/heads/agent/abc123/S-38-update",
      ].join("\n")}\n`,
    );
    const result = await runCanary(["--project", "1"], {
      PATH: `${bin}:${process.env.PATH}`,
      CANARY_FAKE: fake,
      CANARY_STAMP: "2026-01-01T00:00:00Z",
      HOME: tempDir("afk-canary-home-"),
    });
    const text = `${result.stdout}${result.stderr}`;
    expect(result.status, text).toBe(0);
    expect(text).not.toMatch(/leftover:/);
  });
});

describe("scripts/up.sh canary hint", () => {
  const upSh = join(repoRoot, "scripts/up.sh");

  it("tells the operator to run the canary before a new spec and does not start it", () => {
    const text = readFileSync(upSh, "utf8");
    expect(text).toMatch(/接新需求前先跑 scripts\/canary\.sh/);
    const invoked = text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return (
        /scripts\/canary\.sh/.test(trimmed) &&
        !trimmed.startsWith("#") &&
        !trimmed.includes("echo")
      );
    });
    expect(invoked).toEqual([]);
  });
});

describe("the operations manual canary section", () => {
  it("explains how to run the canary and what each check means", () => {
    const text = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    expect(text).toMatch(/## .*金丝雀/);
    expect(text).toContain("scripts/canary.sh");
    expect(text).toContain("--through-final");
    expect(text).toMatch(/token/);
    expect(text).toMatch(/decisions/i);
    expect(text).toMatch(/用例名/);
    expect(text).toMatch(/10 分钟/);
    expect(text).toMatch(/清理作业/);
    expect(text).toMatch(/别的需求/);
  });
});
