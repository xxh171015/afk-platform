import { execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitOrThrow } from "@afk/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";

// GET /setup.sh, run with sh as a person runs it from the control tower: in a fresh home directory, with a PATH that
// holds only the tools the test gives it.

let ws: PlatWorkspace;
let home: string;
let tools: string;

beforeEach(async () => {
  ws = await platWorkspace();
  home = mkdtempSync(join(tmpdir(), "afk-home-"));
  tools = mkdtempSync(join(tmpdir(), "afk-tools-"));
});
afterEach(async () => {
  await ws.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

const which = (tool: string) =>
  tool === "node"
    ? process.execPath
    : spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();

// A directory with links to `names` only, for PATH.
function toolbox(names: string[]): string {
  const dir = mkdtempSync(join(tools, "bin-"));
  for (const name of names) symlinkSync(which(name), join(dir, name));
  return dir;
}
const BASICS = ["curl", "mkdir", "chmod", "mv", "rm", "grep", "mktemp"];
const ALL = [...BASICS, "git", "node"];

async function runSetup(
  cwd: string,
  path: string[],
  env: Record<string, string> = {},
) {
  const script = await (await fetch(`${ws.api.url}/setup.sh`)).text();
  // async: the platform the script talks to answers from this process
  return promisify(execFile)("/bin/sh", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: path.join(":"),
      SHELL: "/bin/zsh",
      AFK_HOME: join(home, ".afk"),
      ...env,
    },
  }).then(
    (done) => ({ code: 0, ...done }),
    (failed) => ({
      code: failed.code as number,
      stdout: failed.stdout as string,
      stderr: failed.stderr as string,
    }),
  );
}

const repo = (): Checkout =>
  ws.checkout("backend", "https://github.com/acme/backend.git");

describe("GET /setup.sh", () => {
  it("runs whole when piped into sh, as curl | sh does, and reads nothing more from stdin", async () => {
    const backend = repo();
    const local = join(home, ".local/bin");
    mkdirSync(local, { recursive: true });
    const script = await (await fetch(`${ws.api.url}/setup.sh`)).text();

    const piped = await new Promise<{ code: number | null; stdout: string }>(
      (done) => {
        const child = spawn("/bin/sh", [], {
          cwd: backend.dir,
          env: {
            HOME: home,
            PATH: [local, toolbox(ALL)].join(":"),
            AFK_HOME: join(home, ".afk"),
          },
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.on("close", (code) => done({ code, stdout }));
        child.stdin.end(script);
      },
    );

    expect(piped.code).toBe(0);
    expect(piped.stdout).toContain("Next: open this repo");
  }, 60_000);

  it("runs nothing when the download stopped halfway", async () => {
    const backend = repo();
    const script = await (await fetch(`${ws.api.url}/setup.sh`)).text();
    const cut = script.slice(0, script.lastIndexOf("main"));

    const result = await promisify(execFile)("/bin/sh", ["-c", cut], {
      cwd: backend.dir,
      env: { HOME: home, PATH: toolbox(ALL) },
    });

    expect(result.stdout).toBe("");
    expect(readdirSync(home)).toEqual([]);
  });

  it("leaves the machine as it was when plat cannot be downloaded", async () => {
    const backend = repo();
    const script = (
      await (await fetch(`${ws.api.url}/setup.sh`)).text()
    ).replace(`platform='${ws.api.url}'`, "platform='http://127.0.0.1:9'");

    const result = await promisify(execFile)("/bin/sh", ["-c", script], {
      cwd: backend.dir,
      env: { HOME: home, PATH: toolbox(ALL), SHELL: "/bin/zsh" },
    }).catch((failed) => failed as { stderr: string; code: number });

    expect(result.stderr).toContain("nothing was changed");
    expect(readdirSync(home)).toEqual([]);
  });

  it("is a script for the address it was fetched from", async () => {
    const response = await fetch(`${ws.api.url}/setup.sh`);
    expect(response.headers.get("content-type")).toContain(
      "text/x-shellscript",
    );
    expect(await response.text()).toContain(`platform='${ws.api.url}'`);
  });

  it("stops in a folder that is not a git checkout and installs nothing", async () => {
    const folder = mkdtempSync(join(tools, "plain-"));

    const result = await runSetup(folder, [toolbox(ALL)]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("run this in the planning repo");
    expect(readdirSync(home)).toEqual([]);
  });

  it("names Node and git together when both are missing, and changes nothing", async () => {
    const backend = repo();

    const result = await runSetup(backend.dir, [toolbox(BASICS)]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("nothing was changed");
    expect(result.stderr).toContain("git: xcode-select --install");
    expect(result.stderr).toContain("Node 20 or newer");
    expect(readdirSync(home)).toEqual([]);
  });

  it("puts plat in a writable directory on PATH, remembers the platform and writes the skills, leaving the shell alone", async () => {
    const backend = repo();
    const local = join(home, ".local/bin");
    mkdirSync(local, { recursive: true });

    const path = [local, toolbox(ALL)];
    const result = await runSetup(backend.dir, path);
    const again = await runSetup(backend.dir, path);

    expect(again.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`plat: installed in ${local}`);
    expect(result.stdout).toContain(
      "Next: open this repo in Cursor or Claude Code and type /afk-setup",
    );
    expect(existsSync(join(local, "plat"))).toBe(true);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, ".afk/plat.json"), "utf8")).apiUrl,
    ).toBe(ws.api.url);
    expect(
      existsSync(join(backend.dir, ".agents/skills/afk-setup/SKILL.md")),
    ).toBe(true);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  it("makes ~/.local/bin and adds one line to the shell's configuration when nothing on PATH will do, once", async () => {
    const backend = repo();
    const path = [toolbox(ALL)];

    const first = await runSetup(backend.dir, path);
    const again = await runSetup(backend.dir, path);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain(
      `plat: added ${join(home, ".local/bin")} to PATH in ${join(home, ".zshrc")}`,
    );
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("added");
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(
      '\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
    expect(existsSync(join(home, ".local/bin/plat"))).toBe(true);
  }, 60_000);
});
