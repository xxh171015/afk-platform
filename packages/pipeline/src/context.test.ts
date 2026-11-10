import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readContract, readDomainFiles, renderContext } from "./context.ts";
import { bundleFor } from "./fixtures.ts";
import { readGateConfig } from "./gate.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

const dirs: string[] = [];
let repo: TestRepo | undefined;
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  repo?.cleanup();
  repo = undefined;
});
const ctxDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-ctx-"));
  dirs.push(dir);
  return join(dir, "context");
};
const read = (dir: string, file: string) =>
  readFileSync(join(dir, file), "utf8");
const run = { runId: "R-9", baseSha: "abc123", branch: "agent/T-123" };

describe("renderContext", () => {
  it("writes ticket.md, spec.md and run.json", () => {
    const dir = ctxDir();
    renderContext({ dir, bundle: bundleFor(), run });
    // the ticket file of the bundle, byte for byte
    expect(read(dir, "ticket.md")).toBe(bundleFor().ticket?.file);
    expect(read(dir, "ticket.md")).toContain("Add GET /orders/export.");
    expect(read(dir, "spec.md")).toContain("# S-12 Order export");
    expect(read(dir, "spec.md")).toContain("Customers want CSV.");
    expect(JSON.parse(read(dir, "run.json"))).toEqual({
      stage: "implement",
      runId: "R-9",
      ticket: "T-123",
      spec: "S-12",
      baseSha: "abc123",
      branch: "agent/T-123",
      integrationBranch: "spec/order-export",
      defaultBranch: "main",
      allowedProtectedPaths: [],
      fixCounts: { "gate-fix": 0, "review-fix": 0, "merge-fix": 0 },
      contracts: [],
      domain: null,
    });
  });

  it("puts the approved protected paths and the stage in run.json", () => {
    const dir = ctxDir();
    renderContext({
      dir,
      bundle: bundleFor({
        stage: "gate-fix",
        allowedProtectedPaths: ["openapi/openapi.yaml"],
      }),
      run,
    });
    const runJson = JSON.parse(read(dir, "run.json"));
    expect(runJson.stage).toBe("gate-fix");
    expect(runJson.allowedProtectedPaths).toEqual(["openapi/openapi.yaml"]);
  });

  it("writes the failure log for a fix and the review result for a review-fix", () => {
    const dir = ctxDir();
    const review = {
      verdict: "fix",
      mustFix: [{ file: "a.ts", problem: "null check" }],
    };
    renderContext({
      dir,
      bundle: bundleFor({ stage: "review-fix" }),
      run,
      failureLog: "boom\n",
      review,
    });
    expect(read(dir, "failure/gate.log")).toBe("boom\n");
    expect(JSON.parse(read(dir, "review.json"))).toEqual(review);
  });

  it("writes neither when there is nothing to show", () => {
    const dir = ctxDir();
    renderContext({ dir, bundle: bundleFor(), run });
    expect(existsSync(join(dir, "failure"))).toBe(false);
    expect(existsSync(join(dir, "review.json"))).toBe(false);
    expect(existsSync(join(dir, "contract"))).toBe(false);
    expect(existsSync(join(dir, "domain"))).toBe(false);
    expect(existsSync(join(dir, "note.md"))).toBe(false);
  });

  it("writes note.md when the Run has a Retry note, and never puts it in ticket.md", () => {
    const dir = ctxDir();
    const note = "use the helper in src/orders/csv.ts";
    const bundle = bundleFor({ note });
    renderContext({ dir, bundle, run });
    expect(read(dir, "note.md")).toBe(note);
    expect(read(dir, "ticket.md")).not.toContain(note);
    expect(read(dir, "ticket.md")).toBe(bundle.ticket?.file);
  });

  it("writes GLOSSARY and ADRs under domain/, never AGENTS.md", () => {
    const dir = ctxDir();
    renderContext({
      dir,
      bundle: bundleFor(),
      run,
      domain: [
        { path: "GLOSSARY.md", content: "# terms\n" },
        { path: "docs/adr/0001-pointers.md", content: "# pointers\n" },
      ],
    });
    expect(read(dir, "domain/GLOSSARY.md")).toBe("# terms\n");
    expect(read(dir, "domain/docs/adr/0001-pointers.md")).toBe("# pointers\n");
    expect(existsSync(join(dir, "domain/AGENTS.md"))).toBe(false);
    expect(JSON.parse(read(dir, "run.json")).domain).toEqual([
      "domain/GLOSSARY.md",
      "domain/docs/adr/0001-pointers.md",
    ]);
  });

  it("writes each contract under contract/<repo>/ and points run.json at them", () => {
    const dir = ctxDir();
    const bundle = bundleFor({
      contracts: [
        {
          repo: "backend",
          url: "git@x:backend",
          defaultBranch: "main",
          sha: "c0ffee",
          path: "openapi/openapi.yaml",
        },
        {
          repo: "payments",
          url: "git@x:payments",
          defaultBranch: "main",
          sha: "beef",
          path: "api/openapi.yaml",
        },
      ],
    });
    renderContext({
      dir,
      bundle,
      run,
      contracts: [
        {
          repo: "backend",
          path: "openapi/openapi.yaml",
          content: "backend: 1\n",
        },
        {
          repo: "payments",
          path: "api/openapi.yaml",
          content: "payments: 1\n",
        },
      ],
    });
    expect(read(dir, "contract/backend/openapi.yaml")).toBe("backend: 1\n");
    expect(read(dir, "contract/payments/openapi.yaml")).toBe("payments: 1\n");
    expect(JSON.parse(read(dir, "run.json")).contracts).toEqual([
      { repo: "backend", sha: "c0ffee", file: "contract/backend/openapi.yaml" },
      { repo: "payments", sha: "beef", file: "contract/payments/openapi.yaml" },
    ]);
  });

  it("puts a make-test repo's named gate commands in run.json, with setup on its own and no npm", () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "setup: make setup",
        "commands:",
        "  - name: test",
        "    run: make test",
        "    timeoutSeconds: 60",
        "    junit: reports/junit.xml",
        "",
      ].join("\n"),
    });
    const dir = ctxDir();
    renderContext({
      dir,
      bundle: bundleFor(),
      run,
      gate: readGateConfig(repo.dir, "main"),
    });
    const json = JSON.parse(read(dir, "run.json")) as {
      gate: unknown;
    };
    expect(json.gate).toEqual({
      setup: "make setup",
      commands: [{ name: "test", run: "make test" }],
    });
    expect(JSON.stringify(json)).not.toMatch(/\bnpm\b/);
  });
});

describe("readContract", () => {
  it("reads the contract file as it was at the recorded SHA, not as it is now", () => {
    repo = makeRepo({ "openapi/openapi.yaml": "version: 1\n" });
    const sha = repo.commit(
      { "openapi/openapi.yaml": "version: 2\n" },
      "contract ticket merged",
    );
    repo.commit(
      { "openapi/openapi.yaml": "version: 3\n" },
      "someone changed it later",
    );
    const contract = readContract(repo.dir, {
      sha,
      path: "openapi/openapi.yaml",
    });
    expect(contract).toEqual({
      path: "openapi/openapi.yaml",
      content: "version: 2\n",
    });
  });

  it("fails loudly when the file is not at that SHA", () => {
    repo = makeRepo();
    const sha = repo.commit({ "a.txt": "x\n" }, "c");
    expect(() =>
      readContract(repo?.dir as string, {
        sha,
        path: "openapi/openapi.yaml",
      }),
    ).toThrow(/git show/);
  });
});

describe("readDomainFiles", () => {
  it("reads GLOSSARY and ADRs at that SHA and ignores AGENTS.md", () => {
    repo = makeRepo({
      "GLOSSARY.md": "# v1\n",
      "AGENTS.md": "do not send\n",
      "docs/adr/0001.md": "# adr1\n",
      "src/app.ts": "secret\n",
    });
    const sha = repo.commit(
      {
        "GLOSSARY.md": "# v2\n",
        "AGENTS.md": "still not sent\n",
        "docs/adr/0001.md": "# adr1b\n",
        "docs/adr/0002.md": "# adr2\n",
      },
      "planning",
    );
    repo.commit({ "GLOSSARY.md": "# v3\n" }, "later");
    expect(readDomainFiles(repo.dir, sha)).toEqual([
      { path: "GLOSSARY.md", content: "# v2\n" },
      { path: "docs/adr/0001.md", content: "# adr1b\n" },
      { path: "docs/adr/0002.md", content: "# adr2\n" },
    ]);
  });
});
