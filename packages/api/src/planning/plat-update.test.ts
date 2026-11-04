import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";

// `plat update` installs afk-setup and the planning skills again at the platform's commit, at the levels afk-setup
// is at, and never replaces planning skills the person has for themselves. The skills CLI is replaced by a stand-in
// that writes what it would: SKILL.md under .agents/skills, a link for Claude Code, and skills-lock.json.

let ws: PlatWorkspace;
let home: string;
let calls: { args: string[]; cwd: string }[];
let platformCommit: string;

beforeEach(async () => {
  ws = await platWorkspace();
  home = mkdtempSync(join(tmpdir(), "afk-user-"));
  calls = [];
  platformCommit = (await (await fetch(`${ws.api.url}/version`)).json())
    .platformCommit;
});
afterEach(async () => {
  await ws.close();
  rmSync(home, { recursive: true, force: true });
});

const PLANNING = [
  "grill-with-docs",
  "grilling",
  "domain-modeling",
  "to-spec",
  "to-tickets",
];
const ALL = ["afk-setup", ...PLANNING];

function skill(root: string, name: string, text = `${name} as installed\n`) {
  mkdirSync(join(root, ".agents/skills", name), { recursive: true });
  writeFileSync(join(root, ".agents/skills", name, "SKILL.md"), text);
}

const skillsCli = (command: string, args: string[], cwd: string) => {
  calls.push({ args: [command, ...args], cwd });
  const named = args.flatMap((a, i) => (args[i - 1] === "--skill" ? [a] : []));
  const skills = named.includes("*") ? ALL : named;
  const user = args.includes("-g");
  const root = user ? home : cwd;
  for (const name of skills) {
    skill(root, name);
    if (!user) {
      mkdirSync(join(root, ".claude/skills"), { recursive: true });
      rmSync(join(root, ".claude/skills", name), { force: true });
      symlinkSync(
        `../../.agents/skills/${name}`,
        join(root, ".claude/skills", name),
      );
    }
  }
  if (!user) writeFileSync(join(root, "skills-lock.json"), "{}\n");
  return { code: 0 };
};

const update = (checkout: Checkout) =>
  ws.plat(checkout.dir, ["update"], undefined, {
    env: { HOME: home },
    run: skillsCli,
    platPath: "",
  });

const exclude = (checkout: Checkout) =>
  readFileSync(join(checkout.dir, ".git/info/exclude"), "utf8");

describe("plat update at project level", () => {
  it("installs the whole package at the platform's commit in this repo, kept out of git on this machine only", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(backend.dir, "afk-setup");

    const updated = await update(backend);

    expect(updated.code).toBe(0);
    expect(calls).toEqual([
      {
        args: [
          "npx",
          "-y",
          "skills@latest",
          "add",
          `xxh171015/afk-platform#${platformCommit}`,
          "--skill",
          "*",
          "-y",
        ],
        cwd: backend.dir,
      },
    ]);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    const lines = exclude(backend).split("\n");
    expect(lines).toContain("/.agents/skills/afk-setup");
    expect(lines).toContain("/.claude/skills/to-spec");
    expect(lines).toContain("/skills-lock.json");

    await update(backend);
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
    expect(updated.stdout).toContain(
      "replaced in this repo, as they were not the platform's: afk-setup, to-spec",
    );
  });
});

describe("plat update at user level", () => {
  it("installs the whole package for the user when the user has no planning skills of their own", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(home, "afk-setup");

    await update(backend);

    expect(calls.map((c) => c.args.slice(4))).toEqual([
      [`xxh171015/afk-platform#${platformCommit}`, "--skill", "*", "-g", "-y"],
    ]);
  });

  it("installs afk-setup for the user and the planning skills in this repo when the user has planning skills of their own", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(home, "afk-setup");
    skill(home, "grilling");
    writeFileSync(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({ skills: { grilling: { source: "mattpocock/skills" } } }),
    );

    const updated = await update(backend);

    expect(updated.code).toBe(0);
    expect(
      calls.map((c) => [
        c.cwd,
        ...c.args.slice(5).filter((a) => a !== "--skill"),
      ]),
    ).toEqual([
      [home, "afk-setup", "-g", "-y"],
      [backend.dir, ...PLANNING, "-y"],
    ]);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  });

  it("changes nothing for the user when the user's planning skills are the platform's, and says how to go back to Matt's", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(home, "afk-setup");
    skill(home, "to-spec");
    writeFileSync(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({
        skills: { "to-spec": { source: "xxh171015/afk-platform" } },
      }),
    );

    const updated = await update(backend);

    expect(updated.code).toBe(0);
    expect(calls.filter((c) => c.args.includes("-g"))).toEqual([]);
    expect(calls.map((c) => c.cwd)).toEqual([backend.dir]);
    expect(updated.stdout).toContain(
      "to-spec for you come from the platform, so every project of yours plans with them",
    );
    expect(updated.stdout).toContain(
      "npx skills@latest add mattpocock/skills --skill to-spec -g -y",
    );
  });

  it("brings both up when the skills are in this repo and for the user", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    skill(home, "afk-setup");
    skill(backend.dir, "to-spec", "Matt's to-spec\n");

    const updated = await update(backend);

    expect(calls.map((c) => [c.cwd, c.args.includes("-g")])).toEqual([
      [backend.dir, false],
      [home, true],
    ]);
    expect(updated.stdout).toContain(
      "replaced in this repo, as they were not the platform's: to-spec",
    );
  });
});
