import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, gitOut } from "./exec.ts";
import {
  type GateRecords,
  GateSetupError,
  junitCases,
  junitCounts,
  mergeGateCompare,
  readGateConfig,
  runGate,
} from "./gate.ts";
import { FakeGateSandbox } from "./testing/fakes.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

const junit = (tests: number, skipped = 0) =>
  `<testsuites tests="${tests}"><testsuite name="a" tests="${tests}" skipped="${skipped}"/></testsuites>`;

type ReportCase = {
  name: string;
  classname?: string;
  file?: string;
  status?: "passed" | "failed" | "skipped";
};

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const caseXml = (c: ReportCase) => {
  const attrs = [
    c.file ? `file="${escapeXml(c.file)}"` : "",
    `classname="${escapeXml(c.classname ?? "")}"`,
    `name="${escapeXml(c.name)}"`,
  ]
    .filter(Boolean)
    .join(" ");
  if (c.status === "failed")
    return `<testcase ${attrs}><failure message="boom">trace</failure></testcase>`;
  if (c.status === "skipped") return `<testcase ${attrs}><skipped/></testcase>`;
  return `<testcase ${attrs}/>`;
};

const junitWithCases = (cases: ReportCase[], tests = cases.length) =>
  `<testsuites tests="${tests}"><testsuite name="a" tests="${cases.length}" skipped="${cases.filter((c) => c.status === "skipped").length}">${cases.map(caseXml).join("")}</testsuite></testsuites>`;

const writeXml = (xml: string, exit = 0) =>
  `sh -c 'mkdir -p reports && echo ${Buffer.from(xml).toString("base64")} | base64 -d > reports/junit.xml; exit ${exit}'`;

// A command that writes a JUnit file with the given counts, as a test runner would. The XML travels as
// base64 so no quoting can get in its way.
const writeJunit = (tests: number, skipped = 0) =>
  `sh -c 'mkdir -p reports && echo ${Buffer.from(junit(tests, skipped)).toString("base64")} | base64 -d > reports/junit.xml'`;

// Same commit, same sandbox: the first run fails, the second writes a passing report.
const failThenPass = (
  failed: ReportCase[],
  passed: ReportCase[],
  tests: number,
) => {
  const failXml = Buffer.from(junitWithCases(failed, tests)).toString("base64");
  const passXml = Buffer.from(junitWithCases(passed, tests)).toString("base64");
  return `sh -c 'mkdir -p reports; if [ -f .gate-tried ]; then echo ${passXml} | base64 -d > reports/junit.xml; exit 0; else touch .gate-tried; echo ${failXml} | base64 -d > reports/junit.xml; exit 1; fi'`;
};

type GateCommand = {
  name: string;
  run: string;
  junit?: string | false;
  rerunFiles?: string[];
};

const gatesYaml = (commands: GateCommand[], setup?: string) =>
  [
    setup ? `setup: ${JSON.stringify(setup)}` : "",
    "commands:",
    ...commands.map((c) => {
      const fields = [
        `name: ${c.name}`,
        `run: ${JSON.stringify(c.run)}`,
        "timeoutSeconds: 30",
      ];
      if (c.junit !== false)
        fields.push(`junit: ${JSON.stringify(c.junit ?? "reports/junit.xml")}`);
      if (c.rerunFiles)
        fields.push(`rerunFiles: ${JSON.stringify(c.rerunFiles)}`);
      return `  - { ${fields.join(", ")} }`;
    }),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

function repoWithGate(commands: GateCommand[], setup?: string) {
  repo = makeRepo({
    ".sandcastle/gates.yaml": gatesYaml(commands, setup),
    "src.txt": "v1\n",
  });
  return gitOut(repo.dir, ["rev-parse", "main"]);
}

const gate = (
  over: Partial<Parameters<typeof runGate>[0]> & {
    sandbox: FakeGateSandbox;
    configSha: string;
  },
) =>
  runGate({
    repoDir: repo.dir,
    ref: "main",
    commitSha: gitOut(repo.dir, ["rev-parse", "main"]),
    ...over,
  });

describe("junitCounts", () => {
  it("reads the totals and sums the skipped tests of the suites", () => {
    expect(
      junitCounts(
        '<testsuites tests="9"><testsuite skipped="1" tests="4"/><testsuite skipped="2" tests="5"/></testsuites>',
      ),
    ).toEqual({
      tests: 9,
      skipped: 3,
    });
  });
  it("is undefined when the file is not a JUnit report", () => {
    expect(junitCounts("<html/>")).toBeUndefined();
  });
});

describe("junitCases", () => {
  it("tells passed, failed, errored and skipped cases apart, self-closed or not", () => {
    const xml = `<testsuites tests="5"><testsuite name="orders" tests="5" skipped="1">
      <testcase classname="orders" name="exports a csv" time="0.1"/>
      <testcase classname="orders" name="rejects an empty range"><failure message="boom">trace</failure></testcase>
      <testcase classname="orders" name="blows up"><error message="x"/></testcase>
      <testcase classname="orders" name="keeps the order"><skipped/></testcase>
      <testcase name="a &amp; b &lt;c&gt;"></testcase>
    </testsuite></testsuites>`;
    expect(junitCases(xml)).toEqual([
      { name: "exports a csv", classname: "orders", status: "passed" },
      {
        name: "rejects an empty range",
        classname: "orders",
        status: "failed",
        message: "boom\ntrace",
      },
      {
        name: "blows up",
        classname: "orders",
        status: "failed",
        message: "x",
      },
      { name: "keeps the order", classname: "orders", status: "skipped" },
      { name: "a & b <c>", classname: "", status: "passed" },
    ]);
  });
  it("finds nothing in a file that is not a report", () => {
    expect(junitCases("<html/>")).toEqual([]);
  });
  it("keeps only the first few lines of a failure message", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const xml = `<testsuites tests="1"><testsuite name="a" tests="1"><testcase name="x" classname="c"><failure>${lines.join("\n")}</failure></testcase></testsuite></testsuites>`;
    expect(junitCases(xml)[0]?.message?.split("\n")).toEqual(lines.slice(0, 8));
  });
  it("keeps the file path when the report names one", () => {
    expect(
      junitCases(
        `<testsuites tests="1"><testsuite name="a" tests="1"><testcase file="src/a b.ts" classname="a" name="works"/></testsuite></testsuites>`,
      ),
    ).toEqual([
      {
        name: "works",
        classname: "a",
        file: "src/a b.ts",
        status: "passed",
      },
    ]);
  });
});

describe("a passing gate", () => {
  it("runs the commands in order in a fresh sandbox and reads the counts", async () => {
    const configSha = repoWithGate([
      { name: "typecheck", run: "echo typecheck >> order.log" },
      { name: "test", run: writeJunit(12, 1) },
    ]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const outcome = await gate({ sandbox, configSha });
    expect(outcome).toMatchObject({
      pass: true,
      reasons: [],
      counts: { tests: 12, skipped: 1 },
      failureLog: "",
    });
    expect(outcome.steps.map((s) => [s.name, s.exitCode])).toEqual([
      ["typecheck", 0],
      ["test", 0],
    ]);
    expect(outcome.stepLogs.typecheck).toBeDefined();
    expect(sandbox.opened).toEqual(["main"]);
  });

  it("runs the setup command first", async () => {
    const configSha = repoWithGate(
      [
        {
          name: "test",
          run: `sh -c "test -f setup.done && ${writeJunit(1).slice(7, -1)}"`,
        },
      ],
      "touch setup.done",
    );
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.steps.map((s) => s.name)).toEqual(["setup", "test"]);
    expect(outcome.pass).toBe(true);
  });
});

describe("command lines", () => {
  it("runs a whole command line under the timeout: &&, cd and environment prefixes work", async () => {
    const configSha = repoWithGate([
      {
        name: "compound",
        run: "mkdir sub && cd sub && FOO=bar sh -c 'test \"$FOO\" = bar'",
      },
      { name: "test", run: writeJunit(1) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.steps.map((s) => s.exitCode)).toEqual([0, 0]);
    expect(outcome.pass).toBe(true);
  });

  it("times out the second command of a compound line too", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        "commands:\n  - { name: slow, run: 'true && sleep 5', timeoutSeconds: 1 }\n",
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.steps[0]?.exitCode).toBe(124);
  });

  it("does not need the host's timeout command", async () => {
    const bin = mkdtempSync(join(tmpdir(), "afk-no-timeout-"));
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\nexit 127\n", {
      mode: 0o755,
    });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const configSha = repoWithGate([{ name: "test", run: writeJunit(1) }]);
      const outcome = await gate({
        sandbox: new FakeGateSandbox(repo.dir),
        configSha,
      });
      expect(outcome.pass).toBe(true);
      expect(outcome.steps[0]?.exitCode).toBe(0);
    } finally {
      process.env.PATH = previous;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("hands the command to the sandbox as written, with the timeout as an option", async () => {
    const run = writeJunit(1);
    const configSha = repoWithGate([{ name: "test", run }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const opened = sandbox.open.bind(sandbox);
    const seen: {
      command: string | readonly string[];
      timeoutSeconds: number;
    }[] = [];
    sandbox.open = async (ref) => {
      const session = await opened(ref);
      const exec = session.exec.bind(session);
      session.exec = async (command, options) => {
        seen.push({ command, timeoutSeconds: options.timeoutSeconds });
        return exec(command, options);
      };
      return session;
    };
    const outcome = await gate({ sandbox, configSha });
    expect(outcome.pass).toBe(true);
    expect(seen).toEqual([{ command: run, timeoutSeconds: 30 }]);
  });
});

describe("losing the job mid-gate", () => {
  it("starts no further command once aborted", async () => {
    const configSha = repoWithGate([
      { name: "first", run: "touch first.done" },
      { name: "second", run: "touch second.done" },
    ]);
    const controller = new AbortController();
    const sandbox = new FakeGateSandbox(repo.dir);
    const opened = sandbox.open.bind(sandbox);
    sandbox.open = async (ref) => {
      const session = await opened(ref);
      const exec = session.exec.bind(session);
      // the lease is lost while the first command runs
      session.exec = async (command, options) => {
        const result = await exec(command, options);
        controller.abort();
        return result;
      };
      return session;
    };
    const outcome = await gate({
      sandbox,
      configSha,
      signal: controller.signal,
    });
    expect(outcome.steps.map((s) => s.name)).toEqual(["first"]);
  });
});

describe("a failing gate", () => {
  it("stops at the first failure: later commands do not run", async () => {
    const configSha = repoWithGate([
      { name: "typecheck", run: "sh -c 'echo broken; exit 3'" },
      { name: "test", run: writeJunit(5) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.steps.map((s) => s.name)).toEqual(["typecheck"]);
    expect(outcome.reasons).toEqual(["typecheck failed (exit 3)"]);
    expect(outcome.counts).toBeUndefined(); // no JUnit, so no comparison
    expect(outcome.testCases).toBeUndefined();
  });

  it("keeps the last 200 lines of the failing command for gate-fix, then the verdict", async () => {
    const configSha = repoWithGate([
      { name: "test", run: "sh -c 'seq 1 500; exit 1'" },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    const lines = outcome.failureLog.split("\n");
    expect(lines[0]).toBe("# test failed (exit 1)");
    expect(outcome.failureLog).toContain("\n500\n");
    expect(outcome.failureLog).toContain("\n301\n");
    expect(outcome.failureLog).not.toContain("\n300\n");
    expect(outcome.failureLog).toContain(
      "## Gate verdict\n- test failed (exit 1)",
    );
  });

  it("fails a command that runs out of time", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        "commands:\n  - { name: slow, run: 'sleep 5', timeoutSeconds: 1 }\n",
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.steps[0]?.exitCode).toBe(124); // timeout(1)'s code
  });

  it("fails when the commands pass but no JUnit report comes out", async () => {
    const configSha = repoWithGate([{ name: "test", run: "true" }]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons).toEqual(["no JUnit results"]);
  });
});

describe("the test count guard", () => {
  const baseline = { tests: 10, skipped: 1 };

  it("fails when there are fewer tests than the baseline", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(9, 1) }]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons).toEqual(["fewer tests than the baseline: 9 < 10"]);
    expect(outcome.failureLog).toContain("fewer tests than the baseline");
  });

  it("fails when more tests are skipped than the baseline", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(10, 2) }]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline,
    });
    expect(outcome.reasons).toEqual([
      "more skipped tests than the baseline: 2 > 1",
    ]);
  });

  it("reports both at once, and lets equal or better counts through", async () => {
    let configSha = repoWithGate([{ name: "test", run: writeJunit(5, 4) }]);
    const both = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline,
    });
    expect(both.reasons).toHaveLength(2);
    repo.cleanup();
    configSha = repoWithGate([{ name: "test", run: writeJunit(11, 0) }]);
    const better = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline,
    });
    expect(better.pass).toBe(true);
  });

  it("compares nothing without a baseline", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(1, 1) }]);
    expect(
      (await gate({ sandbox: new FakeGateSandbox(repo.dir), configSha })).pass,
    ).toBe(true);
  });
});

describe("the test name guard", () => {
  const writeNamed = (names: { classname?: string; name: string }[]) =>
    writeXml(
      junitWithCases(
        names.map((n) => ({
          name: n.name,
          classname: n.classname ?? "suite",
        })),
      ),
    );
  const names = (
    ...list: { classname?: string; name: string }[]
  ): { classname: string; name: string }[] =>
    list.map((n) => ({ classname: n.classname ?? "suite", name: n.name }));

  it("fails listing the names that were deleted when another test is added", async () => {
    const configSha = repoWithGate([
      { name: "test", run: writeNamed([{ name: "keeps" }, { name: "added" }]) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: {
        tests: 2,
        skipped: 0,
        names: names({ name: "keeps" }, { name: "gone" }),
      },
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons).toEqual(["removed tests: suite gone"]);
    expect(outcome.removedTests).toEqual(names({ name: "gone" }));
  });

  it("fails when an existing test is renamed", async () => {
    const configSha = repoWithGate([
      { name: "test", run: writeNamed([{ name: "renamed" }]) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: { tests: 1, skipped: 0, names: names({ name: "original" }) },
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons).toEqual(["removed tests: suite original"]);
  });

  it("does not fail when a sibling added tests this ticket never had", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: writeNamed([{ name: "mine" }, { name: "from-sibling" }]),
      },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: { tests: 1, skipped: 0, names: names({ name: "mine" }) },
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.removedTests).toBeUndefined();
  });

  it("fails a merge candidate that dropped a name the other side still has and did not delete", async () => {
    const configSha = repoWithGate([
      { name: "test", run: writeNamed([{ name: "shared" }]) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: { tests: 2, skipped: 0 },
      mergeNames: {
        base: names({ name: "shared" }),
        ours: names({ name: "shared" }, { name: "from-integration" }),
        theirs: names({ name: "shared" }, { name: "from-ticket" }),
      },
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.removedTests).toEqual(
      names({ name: "from-integration" }, { name: "from-ticket" }),
    );
  });

  it("does not require a name main deleted relative to the merge-base", async () => {
    const configSha = repoWithGate([
      { name: "test", run: writeNamed([{ name: "kept" }]) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: { tests: 1, skipped: 0 },
      mergeNames: {
        base: names({ name: "kept" }, { name: "main-deleted" }),
        ours: names({ name: "kept" }),
        theirs: names({ name: "kept" }, { name: "main-deleted" }),
      },
    });
    expect(outcome.pass).toBe(true);
  });

  it("still compares totals when the report has no names", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(9, 0) }]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: {
        tests: 10,
        skipped: 0,
        names: names({ name: "a" }),
      },
    });
    expect(outcome.reasons).toEqual(["fewer tests than the baseline: 9 < 10"]);
    expect(outcome.removedTests).toBeUndefined();
  });

  it("still compares totals when a merge side has no names in the report", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(2, 0) }]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: { tests: 2, skipped: 0, names: names({ name: "kept" }) },
      mergeNames: {
        base: names({ name: "kept" }, { name: "main-deleted" }),
        ours: names({ name: "kept" }),
        theirs: names({ name: "kept" }, { name: "main-deleted" }),
      },
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.removedTests).toBeUndefined();
  });

  it("still compares totals when gates.yaml declares count compare", async () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": `${gatesYaml([{ name: "test", run: writeNamed([{ name: "new" }]) }])}\ntestCompare: counts\n`,
      "src.txt": "v1\n",
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: {
        tests: 2,
        skipped: 0,
        names: names({ name: "old-a" }, { name: "old-b" }),
      },
    });
    expect(outcome.reasons).toEqual(["fewer tests than the baseline: 1 < 2"]);
  });

  it("strips baseline names for a merge candidate when a side is missing", () => {
    const baseline = {
      tests: 2,
      skipped: 0,
      names: names({ name: "kept" }, { name: "from-integration" }),
    };
    expect(mergeGateCompare(baseline, undefined)).toEqual({
      baseline: { tests: 2, skipped: 0 },
    });
    const mergeNames = {
      base: names({ name: "kept" }),
      ours: names({ name: "kept" }),
      theirs: names({ name: "kept" }),
    };
    expect(mergeGateCompare(baseline, mergeNames)).toEqual({
      baseline,
      mergeNames,
    });
  });

  it("lets an approved name disappear", async () => {
    const configSha = repoWithGate([
      { name: "test", run: writeNamed([{ name: "kept" }]) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
      baseline: {
        tests: 2,
        skipped: 0,
        names: names({ name: "kept" }, { name: "gone" }),
      },
      approvedRemoved: names({ name: "gone" }),
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.removedTests).toBeUndefined();
  });
});

describe("the configuration comes from the trusted commit", () => {
  it("ignores a gates.yaml the branch under test changed", async () => {
    const configSha = repoWithGate([{ name: "test", run: "sh -c 'exit 1'" }]);
    // the agent "fixes" the gate by rewriting its configuration on its own branch
    git(repo.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    repo.commit(
      {
        ".sandcastle/gates.yaml": gatesYaml([
          { name: "test", run: writeJunit(1) },
        ]),
      },
      "make the gate pass",
    );
    const branchSha = gitOut(repo.dir, ["rev-parse", "agent/T-1"]);

    const outcome = await runGate({
      repoDir: repo.dir,
      sandbox: new FakeGateSandbox(repo.dir),
      ref: "agent/T-1",
      commitSha: branchSha,
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(readGateConfig(repo.dir, configSha).commands[0]?.run).toBe(
      "sh -c 'exit 1'",
    );
  });

  it("rejects a configuration that is not valid", () => {
    repo = makeRepo({ ".sandcastle/gates.yaml": "commands: []\n" });
    expect(() => readGateConfig(repo.dir, "main")).toThrow();
  });

  it("refuses a field it does not know instead of dropping it", () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml":
        'commands:\n  - { name: test, run: "true", timeoutSeconds: 30, extra: 1 }\n',
    });
    expect(() => readGateConfig(repo.dir, "main")).toThrow();
  });

  it("keeps version and a per-file rerun template", () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "version: 1",
        "commands:",
        '  - { name: test, run: "true", timeoutSeconds: 30, junit: reports/junit.xml, rerunFiles: [pnpm, test] }',
        "",
      ].join("\n"),
    });
    expect(readGateConfig(repo.dir, "main")).toMatchObject({
      version: 1,
      commands: [{ name: "test", rerunFiles: ["pnpm", "test"] }],
    });
  });

  it("keeps declared generated groups", () => {
    repo = makeRepo({
      ".sandcastle/gates.yaml": [
        "commands:",
        '  - { name: test, run: "true", timeoutSeconds: 30 }',
        "generated:",
        "  - paths: [openapi.json, schema.d.ts]",
        "    run: pnpm gen:api",
        "",
      ].join("\n"),
    });
    expect(readGateConfig(repo.dir, "main").generated).toEqual([
      { paths: ["openapi.json", "schema.d.ts"], run: "pnpm gen:api" },
    ]);
  });
});

// What the platform would answer: the outcomes it was told about, looked up as the API does.
class MemoryRecords implements GateRecords {
  readonly stored: {
    tree: string;
    blob: string;
    outcome: Awaited<ReturnType<typeof runGate>>;
  }[] = [];
  remember(outcome: Awaited<ReturnType<typeof runGate>>) {
    this.stored.push({
      tree: outcome.treeSha,
      blob: outcome.configBlob,
      outcome,
    });
  }
  private passing(match: (o: Awaited<ReturnType<typeof runGate>>) => boolean) {
    return this.stored
      .map((s) => s.outcome)
      .filter((o) => o.counts && o.steps.every((s) => s.exitCode === 0))
      .findLast(match);
  }
  async findPassed(tree: string, blob: string) {
    const o = this.passing((o) => o.treeSha === tree && o.configBlob === blob);
    return o?.counts
      ? {
          commitSha: o.commitSha,
          steps: o.steps,
          counts: o.counts,
          ...(o.testCases ? { testCases: o.testCases } : {}),
        }
      : undefined;
  }
}

describe("reusing a stored pass", () => {
  it("does not run the commands again for the same tree under the same gates.yaml", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(3) }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const records = new MemoryRecords();
    const first = await gate({ sandbox, configSha, records });
    records.remember(first);
    // a merge commit whose tree is the same: the candidate of a branch the integration branch did not move under
    const tree = gitOut(repo.dir, ["rev-parse", "main^{tree}"]);
    const candidate = gitOut(repo.dir, [
      "commit-tree",
      tree,
      "-p",
      "main",
      "-m",
      "candidate",
    ]);
    const second = await gate({
      sandbox,
      configSha,
      records,
      commitSha: candidate,
    });
    expect(sandbox.opened).toHaveLength(1);
    expect(second).toMatchObject({
      pass: true,
      commitSha: candidate,
      reusedFrom: first.commitSha,
      counts: { tests: 3, skipped: 0 },
    });
  });

  it("judges a stored pass against today's baseline", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(8) }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const records = new MemoryRecords();
    records.remember(await gate({ sandbox, configSha, records }));
    const second = await gate({
      sandbox,
      configSha,
      records,
      baseline: { tests: 9, skipped: 0 },
    });
    expect(second.pass).toBe(false); // the integration branch gained tests since
    expect(second.reasons).toEqual(["fewer tests than the baseline: 8 < 9"]);
    expect(sandbox.opened).toHaveLength(1);
  });

  it("runs again when the tree or the gates.yaml differ", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(2) }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const records = new MemoryRecords();
    records.remember(await gate({ sandbox, configSha, records }));
    repo.commit({ "src.txt": "v2\n" }, "change the code");
    await gate({ sandbox, configSha, records });
    repo.commit(
      {
        ".sandcastle/gates.yaml": gatesYaml([
          { name: "test", run: writeJunit(4) },
        ]),
      },
      "change the gate",
    );
    const newConfig = gitOut(repo.dir, ["rev-parse", "main"]);
    records.remember(await gate({ sandbox, configSha: newConfig, records }));
    expect(sandbox.opened).toHaveLength(3);
  });

  it("finds no pass among failed results", async () => {
    const configSha = repoWithGate([{ name: "test", run: "sh -c 'exit 1'" }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const records = new MemoryRecords();
    records.remember(await gate({ sandbox, configSha, records }));
    await gate({ sandbox, configSha, records });
    expect(sandbox.opened).toHaveLength(2);
  });
});

describe("a failing setup", () => {
  it("is not a verdict on the change: it throws with the tail of its output", async () => {
    const configSha = repoWithGate(
      [{ name: "test", run: writeJunit(1) }],
      "sh -c 'echo ERR_PNPM_FETCH tls handshake eof; exit 1'",
    );
    const sandbox = new FakeGateSandbox(repo.dir);
    const failing = gate({ sandbox, configSha });
    await expect(failing).rejects.toBeInstanceOf(GateSetupError);
    await expect(failing).rejects.toThrow(
      /gate setup failed \(exit 1\)\nERR_PNPM_FETCH tls handshake eof/,
    );
  });
});

const watchExec = (sandbox: FakeGateSandbox) => {
  const seen: (string | readonly string[])[] = [];
  const opened = sandbox.open.bind(sandbox);
  sandbox.open = async (ref, placement) => {
    const session = await opened(ref, placement);
    const exec = session.exec.bind(session);
    session.exec = async (command, options) => {
      seen.push(command);
      return exec(command, options);
    };
    return session;
  };
  return seen;
};

describe("retrying a failed test on the same commit", () => {
  const flake = {
    name: "flakes",
    classname: "orders",
    file: "orders.test.ts",
    status: "failed" as const,
  };
  const stable = {
    name: "exports",
    classname: "orders",
    file: "orders.test.ts",
    status: "passed" as const,
  };
  const other = {
    name: "other",
    classname: "other",
    file: "other.test.ts",
    status: "passed" as const,
  };

  it("passes and keeps the case when the first run fails and the rerun passes", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: failThenPass(
          [flake, stable, other],
          [{ ...flake, status: "passed" }, stable, other],
          3,
        ),
      },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.counts).toEqual({ tests: 3, skipped: 0 });
    expect(outcome.testCases).toEqual([
      {
        name: "flakes",
        classname: "orders",
        file: "orders.test.ts",
        status: "passed",
        flaky: true,
      },
      {
        name: "exports",
        classname: "orders",
        file: "orders.test.ts",
        status: "passed",
      },
      {
        name: "other",
        classname: "other",
        file: "other.test.ts",
        status: "passed",
      },
    ]);
  });

  it("fails as a test failure when both runs fail", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: writeXml(junitWithCases([flake, stable], 2), 1),
      },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons).toEqual(["test failed (exit 1)"]);
    expect(outcome.steps.map((s) => s.name)).toEqual(["test"]);
  });

  it("publishes the cases that still fail after a rerun, with their file and failure message", async () => {
    const still = [
      {
        name: "exports",
        classname: "orders",
        file: "src/a.test.ts",
        status: "failed" as const,
      },
      {
        name: "imports",
        classname: "orders",
        file: "src/b.test.ts",
        status: "failed" as const,
      },
    ];
    const configSha = repoWithGate([
      { name: "test", run: writeXml(junitWithCases(still, 2), 1) },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.testCases).toEqual([
      {
        name: "exports",
        classname: "orders",
        file: "src/a.test.ts",
        status: "failed",
        message: "boom\ntrace",
      },
      {
        name: "imports",
        classname: "orders",
        file: "src/b.test.ts",
        status: "failed",
        message: "boom\ntrace",
      },
    ]);
  });

  it("reruns the whole test command when there is no per-file template", async () => {
    const run = failThenPass(
      [flake, other],
      [{ ...flake, status: "passed" }, other],
      2,
    );
    const configSha = repoWithGate([{ name: "test", run }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const seen = watchExec(sandbox);
    await gate({ sandbox, configSha });
    expect(seen).toEqual([run, run]);
  });

  it("reruns only the failed files as separate arguments when the command has a template", async () => {
    const passing = junitWithCases([{ ...flake, status: "passed" }, stable], 2);
    repo = makeRepo({
      ".sandcastle/gates.yaml": gatesYaml([
        {
          name: "test",
          run: writeXml(junitWithCases([flake, stable, other], 3), 1),
          rerunFiles: ["sh", "record-args.sh"],
        },
      ]),
      "record-args.sh": [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > rerun-args.txt",
        "mkdir -p reports",
        `echo ${Buffer.from(passing).toString("base64")} | base64 -d > reports/junit.xml`,
        "",
      ].join("\n"),
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const seen = watchExec(sandbox);
    const outcome = await gate({ sandbox, configSha });
    expect(outcome.pass).toBe(true);
    expect(seen[1]).toEqual(["sh", "record-args.sh", "orders.test.ts"]);
    expect(seen).toHaveLength(2);
  });

  it("passes a filename with spaces, quotes or a semicolon as one argument", async () => {
    const names = [`evil; touch pwned`, "a b.ts", `quote'"file.ts`];
    const failed = names.map((file) => ({
      name: file,
      classname: "x",
      file,
      status: "failed" as const,
    }));
    const passing = junitWithCases(
      failed.map((c) => ({ ...c, status: "passed" as const })),
      3,
    );
    repo = makeRepo({
      ".sandcastle/gates.yaml": gatesYaml([
        {
          name: "test",
          run: writeXml(junitWithCases(failed, 3), 1),
          rerunFiles: ["sh", "record-args.sh"],
        },
      ]),
      "record-args.sh": [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > rerun-args.txt",
        "mkdir -p reports",
        `echo ${Buffer.from(passing).toString("base64")} | base64 -d > reports/junit.xml`,
        "",
      ].join("\n"),
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const seen = watchExec(sandbox);
    const outcome = await gate({ sandbox, configSha });
    expect(outcome.pass).toBe(true);
    expect(seen[1]).toEqual(["sh", "record-args.sh", ...names]);
  });

  it("keeps the first report's test count after a per-file rerun", async () => {
    const passingRerun = junitWithCases(
      [{ ...flake, status: "passed" }, stable],
      2,
    );
    repo = makeRepo({
      ".sandcastle/gates.yaml": gatesYaml([
        {
          name: "test",
          run: writeXml(junitWithCases([flake, stable, other], 10), 1),
          rerunFiles: ["sh", "record-args.sh"],
        },
      ]),
      "record-args.sh": [
        "#!/bin/sh",
        "mkdir -p reports",
        `echo ${Buffer.from(passingRerun).toString("base64")} | base64 -d > reports/junit.xml`,
        "",
      ].join("\n"),
    });
    const configSha = gitOut(repo.dir, ["rev-parse", "main"]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.counts).toEqual({ tests: 10, skipped: 0 });
    expect(outcome.testCases).toEqual([
      {
        name: "flakes",
        classname: "orders",
        file: "orders.test.ts",
        status: "passed",
        flaky: true,
      },
      {
        name: "exports",
        classname: "orders",
        file: "orders.test.ts",
        status: "passed",
      },
      {
        name: "other",
        classname: "other",
        file: "other.test.ts",
        status: "passed",
      },
    ]);
  });

  it("writes the rerun report beside the first one", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: failThenPass(
          [flake, other],
          [{ ...flake, status: "passed" }, other],
          2,
        ),
      },
      {
        name: "lint",
        run: "test -f reports/junit.xml.rerun && test -s reports/junit.xml",
        junit: false,
      },
    ]);
    const outcome = await gate({
      sandbox: new FakeGateSandbox(repo.dir),
      configSha,
    });
    expect(outcome.pass).toBe(true);
    expect(outcome.counts).toEqual({ tests: 2, skipped: 0 });
  });

  it("runs the commands after the test when the rerun passes, and fails if one of them fails", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: failThenPass(
          [flake, other],
          [{ ...flake, status: "passed" }, other],
          2,
        ),
      },
      { name: "lint", run: "sh -c 'exit 4'", junit: false },
    ]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const seen = watchExec(sandbox);
    const outcome = await gate({ sandbox, configSha });
    expect(outcome.pass).toBe(false);
    expect(outcome.steps.map((s) => [s.name, s.exitCode])).toEqual([
      ["test", 0],
      ["lint", 4],
    ]);
    expect(outcome.reasons).toEqual(["lint failed (exit 4)"]);
    expect(seen).toHaveLength(3); // test, test rerun, lint
  });

  it("does not rerun setup, typecheck or lint", async () => {
    const configSha = repoWithGate(
      [
        { name: "typecheck", run: "sh -c 'exit 3'", junit: false },
        { name: "test", run: writeJunit(1) },
      ],
      "true",
    );
    const sandbox = new FakeGateSandbox(repo.dir);
    const seen = watchExec(sandbox);
    const outcome = await gate({ sandbox, configSha });
    expect(outcome.pass).toBe(false);
    expect(outcome.steps.map((s) => s.name)).toEqual(["setup", "typecheck"]);
    expect(seen).toEqual(["true", "sh -c 'exit 3'"]);
  });

  it("reuses a pass that included a flaky case for the same tree", async () => {
    const configSha = repoWithGate([
      {
        name: "test",
        run: failThenPass(
          [flake, other],
          [{ ...flake, status: "passed" }, other],
          2,
        ),
      },
    ]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const records = new MemoryRecords();
    const first = await gate({ sandbox, configSha, records });
    records.remember(first);
    const second = await gate({ sandbox, configSha, records });
    expect(sandbox.opened).toHaveLength(1);
    expect(second.reusedFrom).toBe(first.commitSha);
    expect(second.testCases).toEqual(first.testCases);
    expect(second.testCases?.some((c) => c.flaky)).toBe(true);
  });
});
