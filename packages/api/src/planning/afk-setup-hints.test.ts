import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlatWorkspace, platWorkspace } from "../test/plat-workspace.ts";
import { ticketFile } from "../test/ticket-files.ts";

// A repo not yet set up for the platform: the planning commands point the planning agent at the afk-setup skill,
// which it runs itself; the person types nothing.

let ws: PlatWorkspace;

beforeEach(async () => {
  ws = await platWorkspace();
});
afterEach(async () => {
  await ws.close();
});

const SPEC_BODY =
  "## Problem Statement\n\nx\n\n## Solution\n\nx\n\n## User Stories\n\nx\n\n## Implementation Decisions\n\nx\n\n## Testing Decisions\n\nSeam: the HTTP API.\n\n## Out of Scope\n\nx\n\n## Further Notes\n\nx\n";

async function createSpec(dir: string) {
  writeFileSync(join(dirname(dir), "spec.md"), SPEC_BODY);
  return ws.plat(dir, [
    "spec",
    "create",
    "--project",
    "1",
    "--type",
    "feature",
    "--title",
    "Bulk ship",
    "--file",
    "../spec.md",
  ]);
}

describe("a repo not set up for the platform", () => {
  it("plat spec create without a tracker doc still creates the spec and points at the afk-setup skill", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["project", "create", "shop"]);

    const created = await createSpec(backend.dir);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe("S-1\n");
    expect(created.stderr).toContain(
      "this repo is not set up for the platform (no docs/agents/issue-tracker.md): run the afk-setup skill",
    );
  });

  it("plat spec create with a tracker doc that changed points at the afk-setup skill to regenerate it", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);
    const doc = join(backend.dir, "docs/agents/issue-tracker.md");
    writeFileSync(doc, `${readFileSync(doc, "utf8")}\nedited\n`);

    const created = await createSpec(backend.dir);

    expect(created.code).toBe(0);
    expect(created.stderr).toContain(
      "docs/agents/issue-tracker.md is out of date",
    );
    expect(created.stderr).toContain("run the afk-setup skill again");
  });

  it("plat tickets import naming a repo the project lacks points at the afk-setup skill", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    await ws.plat(backend.dir, ["init", "--yes"]);
    await createSpec(backend.dir);
    const tickets = join(dirname(backend.dir), "tickets");
    mkdirSync(tickets);
    const file = ticketFile(1, {
      key: "01-web",
      repo: "web",
      type: "implementation",
      title: "Ship in web",
      modules: ["src/**"],
      acceptance: ["ships"],
    });
    writeFileSync(join(tickets, file.name), file.text);

    const imported = await ws.plat(backend.dir, [
      "tickets",
      "import",
      "S-1",
      "../tickets",
    ]);

    expect(imported.code).not.toBe(0);
    expect(imported.stderr).toContain(
      "repo web does not belong to the project (its repos: backend); if it is another repo, set it up with the afk-setup skill (its checkout is a workspace folder), then import again",
    );
  });

  it("plat spec confirm in a checkout the project does not have confirms, and says no planning docs went and why", async () => {
    const backend = ws.checkout(
      "backend",
      "https://github.com/acme/backend.git",
    );
    const stray = ws.checkout("stray", "https://github.com/acme/stray.git");
    await ws.plat(backend.dir, ["init", "--yes"]);
    await createSpec(backend.dir);
    const tickets = join(dirname(backend.dir), "tickets");
    mkdirSync(tickets);
    const file = ticketFile(1, {
      key: "01-backend",
      repo: "backend",
      type: "implementation",
      title: "Ship",
      modules: ["src/**"],
      acceptance: ["ships"],
    });
    writeFileSync(join(tickets, file.name), file.text);
    await ws.plat(backend.dir, ["tickets", "import", "S-1", "../tickets"]);

    const confirmed = await ws.plat(stray.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.code).toBe(0);
    expect(confirmed.stderr).toContain(
      `${stray.dir} is not a repo of this project, so no planning docs were sent; if it should be, set it up with the afk-setup skill`,
    );
  });
});
