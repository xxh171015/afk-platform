import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderTrackerDoc } from "@afk/cli";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { SKILLS_SHA } from "@afk/shared/skills-sha";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";

// The platform hands out plat itself (one file, node only), so /afk-setup can install it on a machine that has no
// checkout of the platform; and says which version it is, so an older plat can tell.

// asynchronously: the API answering it runs in this process
const run = promisify(execFile);

let ws: PlatWorkspace;
let dir: string;

beforeEach(async () => {
  ws = await platWorkspace();
  dir = mkdtempSync(join(tmpdir(), "afk-plat-bin-"));
});
afterEach(async () => {
  await ws.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the platform's version", () => {
  it("names the platform version, the pinned skills SHA, and a commit of the platform's repo that is on its remote", async () => {
    const response = await fetch(`${ws.api.url}/version`);
    const version = await response.json();
    expect(version).toMatchObject({
      platformVersion: PLATFORM_VERSION,
      skillsSha: SKILLS_SHA,
    });
    // the newest commit HEAD has that a remote has too, so GitHub can resolve it
    const git = (args: string[]) =>
      execFileSync("git", args, { encoding: "utf8" });
    expect(version.platformCommit).toMatch(/^[0-9a-f]{40}$/);
    git(["merge-base", "--is-ancestor", version.platformCommit, "HEAD"]);
    expect(
      git(["branch", "-r", "--contains", version.platformCommit]),
    ).not.toBe("");
  });
});

describe("plat as the platform hands it out", () => {
  it("is one file that runs with node alone and carries its templates and snapshots", async () => {
    const response = await fetch(`${ws.api.url}/cli/plat.mjs`);
    expect(response.status).toBe(200);
    const plat = join(dir, "plat");
    writeFileSync(plat, await response.text(), { mode: 0o755 });

    const version = await run(plat, ["version"]);
    expect(version.stdout.trim()).toBe(PLATFORM_VERSION);

    // the tracker doc needs both the templates and the skills snapshot
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);
    const doc = await run(
      plat,
      ["tracker-doc", "--project", "1", "--repo", "backend"],
      { cwd: dir, env: { ...process.env, AFK_API_URL: ws.api.url } },
    );
    expect(doc.stderr).toBe("");
    const project = await (await fetch(`${ws.api.url}/projects/1`)).json();
    expect(doc.stdout).toBe(renderTrackerDoc(project, "backend"));
  }, 60_000);
});
