import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitOrThrow } from "@afk/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";

// `plat update` and `plat sync` write afk-setup and the planning skills into the planning repo from the copy plat
// carries: no skills CLI, nothing from GitHub, nothing for the user. They stay on this machine (.git/info/exclude).

let ws: PlatWorkspace;
let home: string;

beforeEach(async () => {
  ws = await platWorkspace();
  home = mkdtempSync(join(tmpdir(), "afk-user-"));
});
afterEach(async () => {
  await ws.close();
  rmSync(home, { recursive: true, force: true });
});

// The platform's skills package: every file under skills/<name>/, by its path under skills/.
const packageRoot = fileURLToPath(
  new URL("../../../../skills", import.meta.url),
);
function packageFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const path = relative(packageRoot, full);
        if (path.includes("/")) files[path] = readFileSync(full, "utf8");
      }
    }
  };
  walk(packageRoot);
  return files;
}
const ALL = [
  "afk-setup",
  "domain-modeling",
  "grill-with-docs",
  "grilling",
  "to-spec",
  "to-tickets",
];

function skill(root: string, name: string, text = `${name} as installed\n`) {
  mkdirSync(join(root, ".agents/skills", name), { recursive: true });
  writeFileSync(join(root, ".agents/skills", name, "SKILL.md"), text);
}

// What plat wrote must be the package byte for byte, laid out as the skills CLI lays it out.
function expectThePackageIn(dir: string) {
  for (const [path, text] of Object.entries(packageFiles()))
    expect(readFileSync(join(dir, ".agents/skills", path), "utf8")).toBe(text);
  for (const name of ALL) {
    const link = join(dir, ".claude/skills", name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
  }
}

const platIn = (dir: string, args: string[], env = {}) =>
  ws.plat(dir, args, undefined, {
    env: { HOME: home, ...env },
    platPath: "",
  });
const update = (checkout: Checkout) => platIn(checkout.dir, ["update"]);

const exclude = (checkout: Checkout) =>
  readFileSync(join(checkout.dir, ".git/info/exclude"), "utf8");

describe("plat update at project level", () => {
  it("installs the whole package at the platform's commit in this repo, kept out of git on this machine only", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );

    const updated = await update(backend);

    expect(updated.code).toBe(0);
    expectThePackageIn(backend.dir);
    expect(existsSync(join(backend.dir, "skills-lock.json"))).toBe(false);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    const lines = exclude(backend).split("\n");
    expect(lines).toContain("/.agents/skills/afk-setup");
    expect(lines).toContain("/.claude/skills/to-spec");

    const again = await update(backend);
    expect(again.stdout).toContain(
      "skills: the platform's, up to date in this repo",
    );
    expect(exclude(backend)).toBe(lines.join("\n"));
  });

  it("leaves a skills-lock.json the repo tracks in git, and says which skills of others it replaced", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      {
        "skills-lock.json": "{}\n",
      },
    );
    skill(backend.dir, "afk-setup");
    skill(backend.dir, "to-spec", "Matt's to-spec\n");

    const updated = await update(backend);

    expect(exclude(backend)).not.toContain("skills-lock.json");
    expect(readFileSync(join(backend.dir, "skills-lock.json"), "utf8")).toBe(
      "{}\n",
    );
    expect(updated.stdout).toContain(
      "replaced in this repo with the platform's: afk-setup, to-spec",
    );
    expectThePackageIn(backend.dir);
  });
});

describe("plat sync puts the platform's skills in the planning repo", () => {
  it("writes them from the plat the platform hands out, with no skills CLI and nothing but the platform to reach", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    // the bundle runs from a folder of its own, far from the platform's skills/ folder
    const bin = mkdtempSync(join(tmpdir(), "afk-bin-"));
    const plat = join(bin, "plat");
    writeFileSync(
      plat,
      await (await fetch(`${ws.api.url}/cli/plat.mjs`)).text(),
    );

    // async: the API answering plat runs in this process
    const synced = await promisify(execFile)(process.execPath, [plat, "sync"], {
      cwd: backend.dir,
      encoding: "utf8",
      // no npx on PATH: only node and git
      env: {
        HOME: home,
        PATH: [process.execPath, spawnSync("which", ["git"]).stdout.toString()]
          .map((file) => file.trim().replace(/\/[^/]+$/, ""))
          .join(":"),
        AFK_API_URL: ws.api.url,
        AFK_HOME: ws.afkHome,
      },
    });
    rmSync(bin, { recursive: true, force: true });

    expect(synced.stderr).toBe("");
    expect(synced.stdout).toContain(
      "skills: afk-setup and the planning skills written in this repo, on this machine only (in .git/info/exclude)",
    );
    expectThePackageIn(backend.dir);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  it("does not write over a skill git tracks in this repo, and plat doctor says why the skills fail", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
      { ".claude/skills/to-spec/SKILL.md": "the repo's own to-spec\n" },
    );

    const synced = await platIn(backend.dir, ["sync"]);

    expect(synced.code).toBe(0);
    expect(synced.stdout).toContain(
      "skills: git tracks to-spec in this repo, so plat left them as they are",
    );
    expect(
      readFileSync(
        join(backend.dir, ".claude/skills/to-spec/SKILL.md"),
        "utf8",
      ),
    ).toBe("the repo's own to-spec\n");
    expect(existsSync(join(backend.dir, ".agents/skills/to-spec"))).toBe(false);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");

    const doctor = await platIn(backend.dir, ["doctor", "--json"]);
    const skills = JSON.parse(doctor.stdout).items.find(
      (item: { id: string }) => item.id === "skills",
    );
    expect(skills.status).toBe("fail");
    expect(skills.detail).toContain(
      "to-spec in this repo not the version this platform uses",
    );
    expect(skills.command).toBe("plat sync");
  });

  it("leaves the user's own skills alone, and names the platform's copies an older install put there", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(home, "to-spec", "Matt's to-spec\n");
    skill(home, "afk-setup", "an older afk-setup\n");
    writeFileSync(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({
        skills: {
          "to-spec": { source: "mattpocock/skills" },
          "afk-setup": { source: "xxh171015/afk-platform" },
        },
      }),
    );

    const synced = await platIn(backend.dir, ["sync"]);

    expect(synced.stdout).toContain(
      "you still have the platform's afk-setup for you from an older install",
    );
    expect(synced.stdout).toContain("npx skills@latest remove -g -y afk-setup");
    expect(
      readFileSync(join(home, ".agents/skills/to-spec/SKILL.md"), "utf8"),
    ).toBe("Matt's to-spec\n");
    expect(
      readFileSync(join(home, ".agents/skills/afk-setup/SKILL.md"), "utf8"),
    ).toBe("an older afk-setup\n");
    expect(readdirSync(join(home, ".agents/skills")).sort()).toEqual([
      "afk-setup",
      "to-spec",
    ]);
    expectThePackageIn(backend.dir);
  });

  it("writes no link over the files when the repo's .claude/skills is itself a link to .agents/skills", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    mkdirSync(join(backend.dir, ".agents/skills"), { recursive: true });
    mkdirSync(join(backend.dir, ".claude"), { recursive: true });
    symlinkSync("../.agents/skills", join(backend.dir, ".claude/skills"));

    await platIn(backend.dir, ["sync"]);
    const again = await platIn(backend.dir, ["sync"]);

    for (const [path, text] of Object.entries(packageFiles()))
      expect(
        readFileSync(join(backend.dir, ".agents/skills", path), "utf8"),
      ).toBe(text);
    expect(
      lstatSync(join(backend.dir, ".agents/skills/to-spec")).isDirectory(),
    ).toBe(true);
    expect(again.stdout).toContain(
      "skills: the platform's, up to date in this repo",
    );
  });

  it("names a copy as replaced when only a file beside its SKILL.md differs", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await platIn(backend.dir, ["sync"]);
    writeFileSync(
      join(backend.dir, ".agents/skills/afk-setup/gates.md"),
      "mine\n",
    );

    const synced = await platIn(backend.dir, ["sync"]);

    expect(synced.stdout).toContain(
      "skills: replaced in this repo with the platform's: afk-setup",
    );
    expectThePackageIn(backend.dir);
  });

  it("says to run it in the planning repo when it is not in a git checkout, and writes nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "afk-not-a-repo-"));

    const synced = await platIn(folder, ["sync"]);

    expect(synced.stdout).toContain(
      "skills: this is not a git checkout; run plat sync in the planning repo",
    );
    expect(readdirSync(folder)).toEqual([]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("brings up after a self-update only a repo that has the skills already", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const other = ws.checkout("other", "https://github.com/acme/other.git");
    skill(backend.dir, "afk-setup", "an older afk-setup\n");
    const updated = { AFK_PLAT_UPDATED_FROM: "0.2.0" };

    await platIn(backend.dir, ["blocked"], updated);
    await platIn(other.dir, ["blocked"], updated);

    expectThePackageIn(backend.dir);
    expect(existsSync(join(other.dir, ".agents"))).toBe(false);
    expect(existsSync(join(other.dir, ".claude"))).toBe(false);
  });
});
