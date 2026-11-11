import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorker } from "../test/fake-worker.ts";
import {
  type Checkout,
  type PlatWorkspace,
  platWorkspace,
} from "../test/plat-workspace.ts";
import { ticketFile } from "../test/ticket-files.ts";

// Planning docs (GLOSSARY Planning docs, ADR 0005): `plat spec confirm` in the planning repo sends the planning
// docs as a patch, the platform makes the planning commit before any ticket starts, and nobody commits by hand.

let ws: PlatWorkspace;

beforeEach(async () => {
  ws = await platWorkspace();
});
afterEach(async () => {
  await ws.close();
});

// biome-ignore lint/suspicious/noExplicitAny: test-only view of a JSON reply
type Json = any;

async function get(path: string): Promise<Json> {
  return (await fetch(`${ws.api.url}${path}`)).json();
}

const SPEC_BODY =
  "## Problem Statement\n\nx\n\n## Solution\n\nx\n\n## User Stories\n\nx\n\n## Implementation Decisions\n\nx\n\n## Testing Decisions\n\nSeam: the HTTP API.\n\n## Out of Scope\n\nx\n\n## Further Notes\n\nx\n";

// A project with backend (the planning repo, where plat init wrote the tracker doc) and frontend, and a draft
// spec S-1 made in backend with one ticket in each repo.
async function draftSpec(
  ticketRepos = ["backend", "frontend"],
): Promise<{ backend: Checkout; frontend: Checkout }> {
  const backend = ws.checkout(
    "backend",
    "https://github.com/acme/backend.git",
    {
      "GLOSSARY.md": "# Orders\n\n**Order**: a purchase.\n",
      "docs/adr/0001-first.md": "# First\n",
      "README.md": "b\n",
    },
  );
  const frontend = ws.checkout(
    "frontend",
    "https://github.com/acme/frontend.git",
  );
  expect(
    (await ws.plat(backend.dir, ["init", "--with", frontend.dir, "--yes"]))
      .code,
  ).toBe(0);
  // what plat init wrote stays on this machine, out of git (ADR 0007)
  expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
  const outside = dirname(backend.dir);
  writeFileSync(join(outside, "spec.md"), SPEC_BODY);
  const created = await ws.plat(backend.dir, [
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
  expect(created.stdout).toBe("S-1\n");
  mkdirSync(join(outside, "tickets"));
  for (const [i, repo] of ticketRepos.entries()) {
    const file = ticketFile(1, {
      key: `0${i + 1}-${repo}`,
      repo,
      type: "implementation",
      title: `Ship in ${repo}`,
      modules: [`src/${repo}/**`],
      acceptance: ["ships"],
    });
    writeFileSync(join(outside, "tickets", file.name), file.text);
  }
  expect(
    (await ws.plat(backend.dir, ["tickets", "import", "S-1", "../tickets"]))
      .code,
  ).toBe(0);
  return { backend, frontend };
}

// The jobs a worker can take now, taken and left unfinished.
async function claimAll(worker: FakeWorker) {
  const jobs: Json[] = [];
  for (;;) {
    const { body } = await worker.claim();
    if (!body.job) return jobs;
    jobs.push(body.job);
  }
}

describe("the planning repo of a spec", () => {
  it("is the repo plat spec create ran in, read from its tracker doc", async () => {
    await draftSpec();
    const view = await get("/specs/1");
    expect(view.spec.planning).toEqual({
      repo: "backend",
      state: null,
      sha: null,
      conflict: [],
    });
  });
});

describe("plat spec confirm in the planning repo", () => {
  it("sends the planning docs changed since the remote's default branch, takes them out of the checkout, and starts no ticket before the planning commit", async () => {
    const { backend } = await draftSpec();
    writeFileSync(
      join(backend.dir, "GLOSSARY.md"),
      "# Orders\n\n**Order**: a purchase.\n\n**Bulk ship**: shipping many orders at once.\n",
    );
    writeFileSync(join(backend.dir, "docs/adr/0002-bulk.md"), "# Bulk\n");
    writeFileSync(join(backend.dir, "src.ts"), "not a planning doc\n");
    const branchBefore = gitOrThrow(backend.dir, ["branch", "--show-current"]);

    const confirmed = await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.stderr).toBe("");
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toContain(
      "planning docs GLOSSARY.md, docs/adr/0002-bulk.md go to the platform",
    );
    expect(confirmed.stdout).not.toContain("stash");
    expect(confirmed.stdout).not.toContain("queued T-");
    // the planning docs are as HEAD has them; the person's other work is left as it was
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe(
      "?? src.ts",
    );
    expect(gitOrThrow(backend.dir, ["stash", "list"])).toBe("");
    expect(gitOrThrow(backend.dir, ["branch", "--show-current"])).toBe(
      branchBefore,
    );
    expect(
      readFileSync(
        join(ws.afkHome, "planning/S-1/planning-docs.patch"),
        "utf8",
      ),
    ).toContain("+**Bulk ship**: shipping many orders at once.");
    expect((await get("/specs/1")).spec.planning.state).toBe("pending");

    const worker = new FakeWorker(ws.api.url, "w1");
    const jobs = await claimAll(worker);
    expect(jobs.map((j) => j.type)).toEqual(["planning-commit"]);
    const task = await get(
      `/worker/jobs/${jobs[0].id}/planning-task?workerId=w1&attempt=${jobs[0].attempt}`,
    );
    expect(task.repo).toMatchObject({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      defaultBranch: "main",
    });
    expect(task.integrationBranch).toMatch(/^spec\/[0-9a-f]{6}\/bulk-ship$/);
    expect(task.patch).toContain(
      "+**Bulk ship**: shipping many orders at once.",
    );
    expect(task.patch).toContain("docs/adr/0002-bulk.md");
    expect(task.patch).not.toContain("src.ts");
    expect(task.message).toBe("Planning docs for S-1 Bulk ship\n\nSpec: S-1");
  });
});

describe("the planning docs in the checkout after confirm", () => {
  it("are put aside only where they are not committed: a planning doc committed here and other changes stay", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "docs/adr/0002-local.md"), "# Local\n");
    gitOrThrow(backend.dir, ["add", "docs/adr/0002-local.md"]);
    gitOrThrow(backend.dir, ["commit", "--quiet", "-m", "local adr"]);
    writeFileSync(join(backend.dir, "README.md"), "b, changed\n");
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");
    mkdirSync(join(backend.dir, "docs/adr/new"));
    writeFileSync(join(backend.dir, "docs/adr/new/0003-new.md"), "# New\n");
    gitOrThrow(backend.dir, ["add", "docs/adr/new/0003-new.md"]);

    const confirmed = await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.code).toBe(0);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe(
      "M README.md",
    );
    expect(existsSync(join(backend.dir, "docs/adr/0002-local.md"))).toBe(true);
    expect(existsSync(join(backend.dir, "docs/adr/new"))).toBe(false);
    expect(readFileSync(join(backend.dir, "GLOSSARY.md"), "utf8")).toBe(
      "# Orders\n\n**Order**: a purchase.\n",
    );
  });

  it("in a multi-context repo include the glossary map and each context's docs", async () => {
    const { backend } = await draftSpec();
    mkdirSync(join(backend.dir, "src/billing"), { recursive: true });
    writeFileSync(
      join(backend.dir, "GLOSSARY-MAP.md"),
      "- [Billing](./src/billing/GLOSSARY.md)\n",
    );
    writeFileSync(join(backend.dir, "src/billing/GLOSSARY.md"), "# Billing\n");
    writeFileSync(join(backend.dir, "src/billing/code.ts"), "export {};\n");

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(gitOrThrow(backend.dir, ["status", "--porcelain", "-uall"])).toBe(
      "?? src/billing/code.ts",
    );
  });

  it("are not sent while a merge of them is unfinished", async () => {
    const { backend } = await draftSpec();
    gitOrThrow(backend.dir, ["checkout", "--quiet", "-b", "other"]);
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# other\n");
    gitOrThrow(backend.dir, ["commit", "--quiet", "-am", "other"]);
    gitOrThrow(backend.dir, ["checkout", "--quiet", "main"]);
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# main\n");
    gitOrThrow(backend.dir, ["commit", "--quiet", "-am", "main"]);
    spawnSync("git", ["merge", "--quiet", "other"], { cwd: backend.dir });

    const confirmed = await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.code).toBe(1);
    expect(confirmed.stderr).toContain(
      "resolve the conflicts in GLOSSARY.md first",
    );
    expect((await get("/specs/1")).spec.state).toBe("draft");
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe(
      "UU GLOSSARY.md",
    );
  });

  it("are left where they are when the platform refuses the confirm", async () => {
    const { backend } = await draftSpec();
    expect((await ws.plat(backend.dir, ["spec", "confirm", "S-1"])).code).toBe(
      0,
    );
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");

    const again = await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(again.code).toBe(1);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe(
      "M GLOSSARY.md",
    );
  });
});

describe("the planning commit", () => {
  it("lets the tickets start once the worker has made it, and gives other repos' tickets its SHA", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [job] = await claimAll(worker);
    const sha = "a".repeat(40);

    const done = await worker.complete(job.id, job.attempt, {
      stage: "planning-commit",
      outcome: "committed",
      sha,
    });

    expect(done.status).toBe(200);
    expect((await get("/specs/1")).spec.planning).toEqual({
      repo: "backend",
      state: "done",
      sha,
      conflict: [],
    });
    const tickets = await claimAll(worker);
    expect(tickets).toHaveLength(2);
    const frontendJob = tickets.find(
      (j: Json) => j.payload.ticketId === 2,
    ) as Json;
    const bundle = await get(
      `/worker/jobs/${frontendJob.id}/bundle?workerId=w1&attempt=${frontendJob.attempt}`,
    );
    expect(bundle.domain).toMatchObject({ repo: "backend", sha });
    const patch = await ws.db.pool.query(
      "SELECT planning_patch FROM specs WHERE id = 1",
    );
    expect(patch.rows[0].planning_patch).toBeNull();
  });
});

describe("what plat spec confirm sends", () => {
  it("carries planning docs committed here but not pushed, and nothing others put on the default branch since", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "docs/adr/0002-local.md"), "# Local\n");
    gitOrThrow(backend.dir, ["add", "docs/adr/0002-local.md"]);
    gitOrThrow(backend.dir, ["commit", "--quiet", "-m", "local adr"]);
    backend.origin.commit(
      { "docs/adr/0003-theirs.md": "# Theirs\n" },
      "theirs",
    );
    gitOrThrow(backend.dir, ["fetch", "--quiet", "origin"]);

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const worker = new FakeWorker(ws.api.url, "w1");
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    expect(task.patch).toContain("docs/adr/0002-local.md");
    expect(task.patch).not.toContain("0003-theirs");
  });

  // afk-setup pushed afk/setup with an AGENTS.md section; the person plans in that worktree (ADR 0006).
  function pushSetup(backend: Checkout): void {
    gitOrThrow(backend.dir, ["checkout", "--quiet", "-b", "afk/setup"]);
    writeFileSync(
      join(backend.dir, "AGENTS.md"),
      "# Backend\n\n## Running unattended\n",
    );
    gitOrThrow(backend.dir, ["add", "AGENTS.md"]);
    gitOrThrow(backend.dir, [
      "commit",
      "--quiet",
      "-m",
      "Set up for the AFK platform",
    ]);
    gitOrThrow(backend.dir, ["push", "--quiet", "-u", "origin", "afk/setup"]);
  }

  async function sentPatch(): Promise<string> {
    const worker = new FakeWorker(ws.api.url, "w1");
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    return task.patch;
  }

  it("from the person's own branch carries the planning docs only: not plat init's local files, not the setup on afk/setup", async () => {
    const { backend } = await draftSpec();
    pushSetup(backend);
    gitOrThrow(backend.dir, ["checkout", "--quiet", "-b", "my-work", "main"]);
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");
    writeFileSync(join(backend.dir, "docs/adr/0002-bulk.md"), "# Bulk\n");

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const patch = await sentPatch();
    const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map(
      (m) => m[1],
    );
    expect(files).toEqual(["GLOSSARY.md", "docs/adr/0002-bulk.md"]);
  });

  it("once the default branch has the setup, is taken against the default branch again", async () => {
    const { backend } = await draftSpec();
    pushSetup(backend);
    // a spec that carried the setup was merged, and the person is back on main
    gitOrThrow(backend.dir, ["checkout", "--quiet", "main"]);
    gitOrThrow(backend.dir, [
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "S-0",
      "afk/setup",
    ]);
    writeFileSync(join(backend.dir, "docs/adr/0003-later.md"), "# Later\n");
    gitOrThrow(backend.dir, ["add", "-A"]);
    gitOrThrow(backend.dir, ["commit", "--quiet", "-m", "someone's adr"]);
    gitOrThrow(backend.dir, ["push", "--quiet", "origin", "main"]);
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const patch = await sentPatch();
    expect(patch).toContain("+# Orders v2");
    expect(patch).not.toContain("0003-later");
    expect(patch).not.toContain("Running unattended");
  });

  it("in a multi-context repo carries GLOSSARY-MAP.md and each context's glossary and ADRs", async () => {
    const { backend } = await draftSpec();
    const files: Record<string, string> = {
      "GLOSSARY-MAP.md":
        "# Glossary Map\n\n## Contexts\n\n- [Ordering](./src/ordering/GLOSSARY.md): orders\n- [Billing](src/billing/GLOSSARY.md): invoices\n",
      "src/ordering/GLOSSARY.md": "# Ordering\n",
      "src/ordering/docs/adr/0001-orders.md": "# Orders\n",
      "src/billing/GLOSSARY.md": "# Billing\n",
      "src/billing/code.ts": "export {};\n",
      "src/shipping/GLOSSARY.md": "# Not in the map\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(backend.dir, path)), { recursive: true });
      writeFileSync(join(backend.dir, path), text);
    }

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const patch = await sentPatch();
    expect(patch).toContain("GLOSSARY-MAP.md");
    expect(patch).toContain("src/ordering/GLOSSARY.md");
    expect(patch).toContain("src/ordering/docs/adr/0001-orders.md");
    expect(patch).toContain("src/billing/GLOSSARY.md");
    expect(patch).not.toContain("code.ts");
    expect(patch).not.toContain("src/shipping");
  });

  it("in a multi-context repo carries a context taken out of the map since the default branch", async () => {
    const { backend } = await draftSpec();
    backend.origin.commit(
      {
        "GLOSSARY-MAP.md":
          "# Glossary Map\n\n- [Billing](./src/billing/GLOSSARY.md)\n- [Docs](https://example.com/x/GLOSSARY.md)\n",
        "src/billing/GLOSSARY.md": "# Billing\n",
      },
      "contexts",
    );
    gitOrThrow(backend.dir, ["pull", "--quiet", "origin", "main"]);
    writeFileSync(join(backend.dir, "GLOSSARY-MAP.md"), "# Glossary Map\n");
    rmSync(join(backend.dir, "src/billing"), { recursive: true });

    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const patch = await sentPatch();
    expect(patch).toContain("deleted file mode");
    expect(patch).toContain("src/billing/GLOSSARY.md");
    expect(patch).toContain("-- [Billing]");
  });

  it("refuses a patch over 1 MB", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "x".repeat(1_100_000));

    const confirmed = await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.code).not.toBe(0);
    expect(confirmed.stderr).toContain("is over 1000000 bytes");
    expect((await get("/specs/1")).spec.state).toBe("draft");
  });

  it("refuses to run in another repo of the project", async () => {
    const { frontend } = await draftSpec();

    const confirmed = await ws.plat(frontend.dir, ["spec", "confirm", "S-1"]);

    expect(confirmed.code).not.toBe(0);
    expect(confirmed.stderr).toContain(
      "S-1's planning docs are in backend, not frontend: run plat spec confirm in a checkout of backend",
    );
  });

  it("outside the project's repos sends nothing, like the page: the planning commit is the default branch's head", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# changed, not sent\n");

    const confirmed = await ws.plat(dirname(backend.dir), [
      "spec",
      "confirm",
      "S-1",
    ]);

    expect(confirmed.code).toBe(0);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    expect(task.patch).toBeNull();
  });

  it("a spec not made in a planning repo has no planning commit, and its tickets start at once", async () => {
    const { backend } = await draftSpec();
    await ws.db.pool.query("UPDATE specs SET planning_repo_id = NULL");

    const confirmed = await ws.plat(dirname(backend.dir), [
      "spec",
      "confirm",
      "S-1",
    ]);

    expect(confirmed.stdout).toContain("queued T-1");
    expect((await get("/specs/1")).spec.planning.state).toBeNull();
    const jobs = await claimAll(new FakeWorker(ws.api.url, "w1"));
    expect(jobs.map((j) => j.type)).not.toContain("planning-commit");
  });
});

describe("a planning docs patch that does not apply", () => {
  async function blockedSpec() {
    const { backend, frontend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# mine\n");
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [job] = await claimAll(worker);
    await worker.complete(job.id, job.attempt, {
      stage: "planning-commit",
      outcome: "conflict",
      files: ["GLOSSARY.md"],
    });
    return { backend, frontend, worker };
  }

  it("blocks the spec's start and waits for a person in plat blocked", async () => {
    const { backend, worker } = await blockedSpec();

    expect((await get("/specs/1")).spec.planning).toMatchObject({
      state: "blocked",
      conflict: ["GLOSSARY.md"],
    });
    expect(await claimAll(worker)).toEqual([]);
    const blocked = await ws.plat(backend.dir, ["blocked"]);
    expect(blocked.stdout).toContain(
      "S-1  the planning docs did not apply to backend's default branch: GLOSSARY.md",
    );
    expect(blocked.stdout).toContain("plat spec retry-planning S-1");
    expect(blocked.stdout).toContain("plat spec waive-planning S-1");
  });

  it("puts the block on the spec: its planning docs did not apply", async () => {
    await blockedSpec();
    const event = await ws.db.pool.query(
      "SELECT reason, failure_source FROM events WHERE type = 'planning' AND to_state = 'blocked'",
    );
    expect(event.rows).toEqual([
      { reason: "planning-conflict", failure_source: "spec" },
    ]);
  });

  it("retry-planning, in the planning repo, sends the docs again and makes the planning commit again", async () => {
    const { backend, worker } = await blockedSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# mine, merged by hand\n");

    const retried = await ws.plat(backend.dir, [
      "spec",
      "retry-planning",
      "S-1",
    ]);

    expect(retried.code).toBe(0);
    expect((await get("/specs/1")).spec.planning.state).toBe("pending");
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    expect(task.patch).toContain("+# mine, merged by hand");
  });

  it("retry-planning first puts the docs confirm took back, conflicts marked, and sends them once they are resolved", async () => {
    const { backend, worker } = await blockedSpec();
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    backend.origin.commit({ "GLOSSARY.md": "# theirs\n" }, "theirs");
    gitOrThrow(backend.dir, ["pull", "--quiet", "origin", "main"]);

    const back = await ws.plat(backend.dir, ["spec", "retry-planning", "S-1"]);

    expect(back.code).toBe(0);
    expect(back.stdout).toContain("put back in this checkout");
    expect(back.stdout).toContain(
      "resolve the conflicts marked in GLOSSARY.md",
    );
    const merged = readFileSync(join(backend.dir, "GLOSSARY.md"), "utf8");
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("# mine");
    expect(merged).toContain("# theirs");
    expect(await claimAll(worker)).toEqual([]);

    const early = await ws.plat(backend.dir, ["spec", "retry-planning", "S-1"]);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("resolve the conflicts in GLOSSARY.md");

    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# theirs and mine\n");
    const sent = await ws.plat(backend.dir, ["spec", "retry-planning", "S-1"]);

    expect(sent.code).toBe(0);
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    expect(task.patch).toContain("+# theirs and mine");
    expect(
      readFileSync(
        join(ws.afkHome, "planning/S-1/planning-docs.patch"),
        "utf8",
      ),
    ).toContain("+# theirs and mine");
  });

  it("retry-planning sends planning docs committed here at once", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# mine, committed\n");
    gitOrThrow(backend.dir, ["commit", "--quiet", "-am", "glossary"]);
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [first] = await claimAll(worker);
    await worker.complete(first.id, first.attempt, {
      stage: "planning-commit",
      outcome: "conflict",
      files: ["GLOSSARY.md"],
    });
    expect(existsSync(join(ws.afkHome, "planning/S-1"))).toBe(false);

    const sent = await ws.plat(backend.dir, ["spec", "retry-planning", "S-1"]);

    expect(sent.stdout).toContain("sent again");
    expect(
      (
        await ws.db.pool.query(
          "SELECT source, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows.at(-1),
    ).toEqual({ source: "cli", action: "retry-planning" });
    expect(gitOrThrow(backend.dir, ["status", "--porcelain"])).toBe("");
    const [job] = await claimAll(worker);
    expect(job.type).toBe("planning-commit");
  });

  it("waive-planning drops the copy confirm kept", async () => {
    const { backend } = await blockedSpec();
    expect(existsSync(join(ws.afkHome, "planning/S-1"))).toBe(true);

    await ws.plat(backend.dir, ["spec", "waive-planning", "S-1"]);

    expect(existsSync(join(ws.afkHome, "planning/S-1"))).toBe(false);
    expect(
      (
        await ws.db.pool.query(
          "SELECT source, data->>'action' AS action FROM events WHERE type = 'action' ORDER BY id",
        )
      ).rows.at(-1),
    ).toEqual({ source: "cli", action: "waive-planning" });
  });

  it("waive-planning gives the docs up: the planning commit is the default branch's head and the spec says the docs were waived", async () => {
    const { backend, worker } = await blockedSpec();

    const waived = await ws.plat(backend.dir, [
      "spec",
      "waive-planning",
      "S-1",
    ]);

    expect(waived.code).toBe(0);
    const [job] = await claimAll(worker);
    const task = await get(
      `/worker/jobs/${job.id}/planning-task?workerId=w1&attempt=${job.attempt}`,
    );
    expect(task.patch).toBeNull();
    await worker.complete(job.id, job.attempt, {
      stage: "planning-commit",
      outcome: "unchanged",
      sha: "b".repeat(40),
    });
    expect((await get("/specs/1")).spec.planning).toMatchObject({
      state: "waived",
      sha: "b".repeat(40),
    });
    expect(await claimAll(worker)).toHaveLength(2);
  });

  it("retry and waive are refused unless the planning docs are blocked", async () => {
    const { backend } = await draftSpec();
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    const retried = await ws.plat(backend.dir, [
      "spec",
      "retry-planning",
      "S-1",
    ]);
    const waived = await ws.plat(backend.dir, [
      "spec",
      "waive-planning",
      "S-1",
    ]);

    expect(retried.code).not.toBe(0);
    expect(retried.stderr).toContain("S-1's planning docs are not blocked");
    expect(waived.code).not.toBe(0);
  });
});

describe("a planning commit the worker cannot make", () => {
  it("is tried three times in a row, then waits for a person", async () => {
    const { backend } = await draftSpec();
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");

    for (let i = 0; i < 3; i++) {
      const [job] = await claimAll(worker);
      expect(job.type).toBe("planning-commit");
      await worker.fail(job.id, job.attempt, "could not push");
    }

    expect(await claimAll(worker)).toEqual([]);
    expect((await get("/specs/1")).spec.planning.state).toBe("blocked");
    expect((await ws.plat(backend.dir, ["blocked"])).stdout).toContain(
      "S-1  the planning commit could not be made in backend: its job failed three times",
    );
    // its job failing is no fault of the spec's
    const event = await ws.db.pool.query(
      "SELECT reason, failure_source FROM events WHERE type = 'planning' AND to_state = 'blocked'",
    );
    expect(event.rows).toEqual([
      { reason: "job-failed", failure_source: "platform" },
    ]);
    expect((await get("/blocked")).planning[0].failureSource).toBe("platform");
  });
});

describe("the planning docs at the end of the spec", () => {
  const PASS: Record<string, Record<string, unknown>> = {
    implement: { outcome: "done" },
    gate: { outcome: "passed" },
    review: { outcome: "pass" },
    merge: { outcome: "merged", headSha: "head" },
  };

  // Every ticket stage passes, until the next job is a step of the finalization (left running).
  async function ticketsToTheirEnd(worker: FakeWorker) {
    for (let i = 0; i < 10; i++) {
      const job = (await worker.claim()).body.job as Json;
      if (!job || job.payload.final) return;
      await worker.complete(job.id, job.attempt, {
        stage: job.payload.stage,
        ...PASS[job.payload.stage],
      });
    }
  }

  it("go out in their own pull request when the planning repo has no ticket of the spec", async () => {
    const { backend } = await draftSpec(["frontend"]);
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# Orders v2\n");
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [planning] = await claimAll(worker);
    await worker.complete(planning.id, planning.attempt, {
      stage: "planning-commit",
      outcome: "committed",
      sha: "c".repeat(40),
    });

    await ticketsToTheirEnd(worker);

    const rows = await ws.db.pool.query(
      `SELECT r.name, f.state FROM finalizations f JOIN repos r ON r.id = f.repo_id ORDER BY r.name`,
    );
    expect(rows.rows).toEqual([
      { name: "backend", state: "done" },
      { name: "frontend", state: "active" },
    ]);
    const finalJobs = await ws.db.pool.query(
      "SELECT payload->>'repoId' AS repo FROM jobs WHERE payload->>'final' = 'true'",
    );
    expect(finalJobs.rows).toEqual([{ repo: "2" }]);
  });

  it("make no pull request of their own when nothing was committed", async () => {
    const { backend } = await draftSpec(["frontend"]);
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    const worker = new FakeWorker(ws.api.url, "w1");
    const [planning] = await claimAll(worker);
    await worker.complete(planning.id, planning.attempt, {
      stage: "planning-commit",
      outcome: "unchanged",
      sha: "d".repeat(40),
    });
    await ticketsToTheirEnd(worker);

    const rows = await ws.db.pool.query(
      `SELECT r.name FROM finalizations f JOIN repos r ON r.id = f.repo_id`,
    );
    expect(rows.rows).toEqual([{ name: "frontend" }]);
  });
});

describe("cancelling a spec whose planning commit is pending", () => {
  it("stops the planning commit and drops the patch", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# v2\n");
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);

    expect((await ws.plat(backend.dir, ["spec", "cancel", "S-1"])).code).toBe(
      0,
    );

    const jobs = await claimAll(new FakeWorker(ws.api.url, "w1"));
    expect(jobs.map((j) => j.type)).not.toContain("planning-commit");
    const row = await ws.db.pool.query(
      "SELECT planning_patch FROM specs WHERE id = 1",
    );
    expect(row.rows[0].planning_patch).toBeNull();
  });
  it("drops the copy confirm kept with the next plat command", async () => {
    const { backend } = await draftSpec();
    writeFileSync(join(backend.dir, "GLOSSARY.md"), "# v2\n");
    await ws.plat(backend.dir, ["spec", "confirm", "S-1"]);
    writeFileSync(join(ws.afkHome, "planning/S-1/01-ticket.md"), "t\n");
    await ws.plat(backend.dir, ["spec", "cancel", "S-1"]);

    await ws.plat(backend.dir, ["spec", "show", "S-1"]);

    expect(existsSync(join(ws.afkHome, "planning/S-1"))).toBe(false);
  });

  it("drops the folder of a merged spec, ticket files only or not, and keeps one from another platform", async () => {
    await draftSpec();
    for (const [spec, meta] of [
      ["S-1", null],
      ["S-2", { apiUrl: "http://elsewhere:3000", repo: "backend", files: [] }],
    ] as const) {
      mkdirSync(join(ws.afkHome, "planning", spec), { recursive: true });
      writeFileSync(join(ws.afkHome, "planning", spec, "01-t.md"), "t\n");
      if (meta) {
        writeFileSync(
          join(ws.afkHome, "planning", spec, "planning-docs.json"),
          JSON.stringify(meta),
        );
        writeFileSync(
          join(ws.afkHome, "planning", spec, "planning-docs.patch"),
          "",
        );
      }
    }
    await ws.db.pool.query("UPDATE specs SET state = 'merged'");

    await ws.plat(dirname(ws.afkHome), ["spec", "show", "S-1"]);

    expect(existsSync(join(ws.afkHome, "planning/S-1"))).toBe(false);
    expect(existsSync(join(ws.afkHome, "planning/S-2"))).toBe(true);
  });
});
