import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";

// A planning machine follows the platform by itself: an older plat replaces itself with the one the platform hands
// out and runs the command again, the API does not take a spec or tickets from an older plat, and the new plat
// brings the skills and the planning files up and says what changed (packages/cli/src/self-update.ts).

let ws: PlatWorkspace;
let dir: string;
let home: string;
let backend: Checkout;
let bundle: string;
let reruns: { file: string; args: string[]; env: Record<string, string> }[];
let installs: string[][];

beforeEach(async () => {
  ws = await platWorkspace();
  dir = mkdtempSync(join(tmpdir(), "afk-plat-self-"));
  home = mkdtempSync(join(tmpdir(), "afk-user-"));
  reruns = [];
  installs = [];
  backend = ws.checkout("backend", "https://github.com/acme/backend.git");
  // set up as afk-setup does, by a plat run from this checkout (it never replaces itself)
  await ws.plat(backend.dir, ["init", "--yes"]);
  bundle = await (await fetch(`${ws.api.url}/cli/plat.mjs`)).text();
}, 60_000);
afterEach(async () => {
  await ws.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// A plat file on this machine with `text`; plat runs as if from it.
function platFileWith(text: string): string {
  const file = join(dir, "plat");
  writeFileSync(file, text, { mode: 0o755 });
  return file;
}

const platFrom = (
  file: string,
  args: string[],
  env: Record<string, string> = {},
) =>
  ws.plat(backend.dir, args, undefined, {
    env: { HOME: home, ...env },
    platPath: file,
    rerun: (f, a, e) => {
      reruns.push({ file: f, args: a, env: e });
      return 7;
    },
    run: (command, args) => {
      installs.push([command, ...args]);
      return { code: 0 };
    },
  });

const specCreate = [
  "spec",
  "create",
  "--project",
  "1",
  "--type",
  "feature",
  "--title",
  "Order export",
  "--file",
  "spec.md",
];

const specCount = async () =>
  Number((await ws.db.pool.query("SELECT count(*) FROM specs")).rows[0].count);

describe("the plat the platform hands out", () => {
  it("is named by its sha256 in GET /version", async () => {
    const version = await (await fetch(`${ws.api.url}/version`)).json();
    expect(version.platFingerprint).toBe(sha256(bundle));
  });
});

describe("publishing from an older plat", () => {
  const post = (headers: Record<string, string>, slug = "order-export") =>
    fetch(`${ws.api.url}/specs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        projectId: 1,
        type: "feature",
        slug,
        title: "Order export",
      }),
    });

  it("is refused before anything is stored, and the reply says plat is out of date", async () => {
    const refused = await post({
      "x-afk-client": "cli",
      "x-afk-plat": sha256("an older plat"),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "plat-outdated" });
    // a plat from before 0.3.0 sends no fingerprint at all
    const older = await post({ "x-afk-client": "cli" });
    expect(older.status).toBe(409);
    expect(await specCount()).toBe(0);
  });

  it("is taken from the current plat, a plat run from a checkout of the platform, and the page", async () => {
    const senders: Record<string, string>[] = [
      { "x-afk-client": "cli", "x-afk-plat": sha256(bundle) },
      { "x-afk-client": "cli", "x-afk-plat": "dev" },
      {},
    ];
    for (const [i, headers] of senders.entries())
      expect((await post(headers, `order-export-${i}`)).status).toBe(201);
  });
});

describe("an older plat", () => {
  it("replaces itself with the platform's and runs the same command again, before it publishes anything", async () => {
    const file = platFileWith("// an older plat\n");
    writeFileSync(join(backend.dir, "spec.md"), "# Order export\n");

    const result = await platFrom(file, specCreate);

    expect(readFileSync(file, "utf8")).toBe(bundle);
    expect(reruns).toEqual([
      {
        file,
        args: specCreate,
        env: { AFK_PLAT_UPDATED_FROM: PLATFORM_VERSION },
      },
    ]);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("replaced itself with the platform's plat");
    expect(await specCount()).toBe(0);
  });

  it("that just replaced itself and is still refused stops and says to run plat update, rather than loop", async () => {
    const file = platFileWith("// still older\n");
    writeFileSync(join(backend.dir, "spec.md"), "# Order export\n");

    const result = await platFrom(file, specCreate, {
      AFK_PLAT_UPDATED_FROM: "0.2.0",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run plat update");
    expect(reruns).toEqual([]);
    expect(await specCount()).toBe(0);
  });
});

describe("the plat that just replaced an older one", () => {
  it("brings the skills and the planning files up before the command, and says in a few lines what changed", async () => {
    const file = platFileWith(bundle);
    const tracker = join(backend.dir, "docs/agents/issue-tracker.md");
    const rules = join(backend.dir, "CLAUDE.local.md");
    const current = { tracker: readFileSync(tracker, "utf8") };
    // an older one names its project and repo on its first line, as every tracker doc plat writes does
    const versionLine = current.tracker.split("\n")[0];
    writeFileSync(tracker, `${versionLine}\nan older tracker doc\n`);
    writeFileSync(rules, "## Planning on this machine\n\n- older rules\n");
    mkdirSync(join(backend.dir, ".agents/skills/afk-setup"), {
      recursive: true,
    });
    writeFileSync(
      join(backend.dir, ".agents/skills/afk-setup/SKILL.md"),
      "an older afk-setup\n",
    );

    const result = await platFrom(file, ["project", "show", "1"], {
      AFK_PLAT_UPDATED_FROM: "0.2.0",
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      `plat: updated itself to the platform's (0.2.0 -> ${PLATFORM_VERSION})`,
    );
    expect(readFileSync(tracker, "utf8")).toBe(current.tracker);
    expect(readFileSync(rules, "utf8")).toContain("run `plat sync`");
    expect(result.stderr).toContain(
      "planning files: docs/agents/issue-tracker.md updated, CLAUDE.local.md updated",
    );
    // the skills are installed again at the platform's commit, in this repo where they are
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("skills@latest");
    expect(reruns).toEqual([]);
  });
});

describe("plat sync", () => {
  it("rewrites planning files that are not the platform's and leaves skills that are alone", async () => {
    const rules = join(backend.dir, "CLAUDE.local.md");
    writeFileSync(rules, "## Planning on this machine\n\n- older rules\n");

    const synced = await ws.plat(backend.dir, ["sync"], undefined, {
      env: { HOME: home },
      platPath: "",
      run: (command, args) => {
        installs.push([command, ...args]);
        return { code: 0 };
      },
    });

    expect(synced.code).toBe(0);
    expect(synced.stdout).toContain("skills: nothing to update");
    expect(synced.stdout).toContain("planning files: CLAUDE.local.md updated");
    expect(readFileSync(rules, "utf8")).toContain("run `plat sync`");
    expect(installs).toEqual([]);

    const again = await ws.plat(backend.dir, ["sync"], undefined, {
      env: { HOME: home },
      platPath: "",
    });
    expect(again.stdout).toContain("planning files: up to date");
  });
});
