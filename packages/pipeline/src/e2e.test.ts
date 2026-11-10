import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runE2e } from "./e2e.ts";
import { gitOut } from "./exec.ts";
import { FakeGateSandbox } from "./testing/fakes.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

const junit = (
  cases: { name: string; failed?: boolean; skipped?: boolean }[],
) =>
  `<testsuites tests="${cases.length}"><testsuite name="e2e" tests="${cases.length}" skipped="${cases.filter((c) => c.skipped).length}">${cases
    .map(
      (c) =>
        `<testcase name="${c.name}" classname="e2e">${c.failed ? "<failure>boom</failure>" : ""}${c.skipped ? "<skipped/>" : ""}</testcase>`,
    )
    .join("")}</testsuite></testsuites>`;

// A repo whose "e2e" is a shell command that writes a JUnit report and exits as told.
function setup(files: Record<string, string> = {}) {
  repo = makeRepo({
    ".sandcastle/gates.yaml":
      'setup: "echo set-up > setup.txt"\ncommands:\n  - { name: test, run: "true", timeoutSeconds: 30 }\n',
    ...files,
  });
  const sha = gitOut(repo.dir, ["rev-parse", "main"]);
  return { sha, sandbox: new FakeGateSandbox(repo.dir) };
}

const writeReport = (xml: string) =>
  `sh -c 'mkdir -p reports && echo ${Buffer.from(xml).toString("base64")} | base64 -d > reports/e2e-junit.xml'`;

const e2e = (
  fixture: ReturnType<typeof setup>,
  command: string,
  over: Partial<Parameters<typeof runE2e>[0]> = {},
) =>
  runE2e({
    repoDir: repo.dir,
    sandbox: fixture.sandbox,
    ref: "main",
    commitSha: fixture.sha,
    configSha: fixture.sha,
    network: "afk-r-9_default",
    env: { BACKEND_URL: "http://backend:8080" },
    command,
    ...over,
  });

describe("runE2e", () => {
  it("passes when the command passes and the report has tests, none failed", async () => {
    const fixture = setup();
    const outcome = await e2e(
      fixture,
      writeReport(junit([{ name: "a" }, { name: "b" }])),
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.counts).toEqual({ tests: 2, skipped: 0, failed: 0 });
    expect(outcome.testCases).toHaveLength(2);
    expect(outcome.commitSha).toBe(fixture.sha);
  });

  it("puts the sandbox on the network with the service addresses, and runs the repo's setup first", async () => {
    const fixture = setup();
    const outcome = await e2e(
      fixture,
      `sh -c 'test "$BACKEND_URL" = http://backend:8080 && test -f setup.txt && ${writeReport(junit([{ name: "a" }]))}'`,
    );
    expect(fixture.sandbox.placements).toEqual([
      {
        network: "afk-r-9_default",
        env: { BACKEND_URL: "http://backend:8080" },
      },
    ]);
    expect(outcome.steps.map((s) => s.name)).toEqual(["setup", "e2e"]);
  });

  it("fails with the failing tests when the report has failures, even if the command exits 0", async () => {
    const fixture = setup();
    const outcome = await e2e(
      fixture,
      writeReport(
        junit([{ name: "ok" }, { name: "export button", failed: true }]),
      ),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.counts).toEqual({ tests: 2, skipped: 0, failed: 1 });
    expect(outcome.failingTests).toEqual(["export button"]);
    expect(outcome.failureLog).toContain("1 of 2 e2e tests failed");
  });

  it("reads the report of a command that failed, which is where the failures are", async () => {
    const fixture = setup();
    const outcome = await e2e(
      fixture,
      `${writeReport(junit([{ name: "x", failed: true }]))}; exit 1`,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.counts?.failed).toBe(1);
    expect(outcome.failureLog).toContain("e2e failed (exit 1)");
  });

  it("fails when there is no report, and when the report has no tests", async () => {
    const none = await e2e(setup(), "true");
    expect(none.pass).toBe(false);
    expect(none.reasons).toContain("no JUnit results");
    const empty = await e2e(setup(), writeReport(junit([])));
    expect(empty.pass).toBe(false);
    expect(empty.reasons).toContain("the e2e report has no tests");
  });

  it("runs no command once the job is lost", async () => {
    const fixture = setup();
    const lost = new AbortController();
    lost.abort();
    const outcome = await e2e(fixture, "true", { signal: lost.signal });
    expect(outcome.steps).toEqual([]);
    expect(outcome.pass).toBe(false);
  });

  it("does not need the host's timeout command", async () => {
    const bin = mkdtempSync(join(tmpdir(), "afk-no-timeout-"));
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\nexit 127\n", {
      mode: 0o755,
    });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const fixture = setup();
      const outcome = await e2e(fixture, writeReport(junit([{ name: "a" }])));
      expect(outcome.pass).toBe(true);
    } finally {
      process.env.PATH = previous;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
