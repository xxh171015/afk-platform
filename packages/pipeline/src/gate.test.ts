import { afterEach, describe, expect, it } from "vitest";
import { git, gitOut } from "./exec.ts";
import {
  GateCache,
  junitCases,
  junitCounts,
  readGateConfig,
  runGate,
} from "./gate.ts";
import { FakeGateSandbox } from "./testing/fakes.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

const junit = (tests: number, skipped = 0) =>
  `<testsuites tests="${tests}"><testsuite name="a" tests="${tests}" skipped="${skipped}"/></testsuites>`;

// A command that writes a JUnit file with the given counts, as a test runner would. The XML travels as
// base64 so no quoting can get in its way.
const writeJunit = (tests: number, skipped = 0) =>
  `sh -c 'mkdir -p reports && echo ${Buffer.from(junit(tests, skipped)).toString("base64")} | base64 -d > reports/junit.xml'`;

const gatesYaml = (commands: { name: string; run: string }[], setup?: string) =>
  [
    setup ? `setup: ${JSON.stringify(setup)}` : "",
    "commands:",
    ...commands.map(
      (c) =>
        `  - { name: ${c.name}, run: ${JSON.stringify(c.run)}, timeoutSeconds: 30, junit: reports/junit.xml }`,
    ),
  ].join("\n");

function repoWithGate(
  commands: { name: string; run: string }[],
  setup?: string,
) {
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
      { name: "rejects an empty range", classname: "orders", status: "failed" },
      { name: "blows up", classname: "orders", status: "failed" },
      { name: "keeps the order", classname: "orders", status: "skipped" },
      { name: "a & b <c>", classname: "", status: "passed" },
    ]);
  });
  it("finds nothing in a file that is not a report", () => {
    expect(junitCases("<html/>")).toEqual([]);
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
      session.exec = async (command) => {
        const result = await exec(command);
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
});

describe("caching by commit", () => {
  it("does not gate the same commit under the same configuration twice", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(3) }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const cache = new GateCache();
    const first = await gate({ sandbox, configSha, cache });
    const second = await gate({ sandbox, configSha, cache });
    expect(second).toBe(first);
    expect(sandbox.opened).toHaveLength(1);
  });

  it("does not reuse a pass against a different baseline", async () => {
    const configSha = repoWithGate([{ name: "test", run: writeJunit(8) }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const cache = new GateCache();
    const first = await gate({
      sandbox,
      configSha,
      cache,
      baseline: { tests: 5, skipped: 0 },
    });
    expect(first.pass).toBe(true);
    const second = await gate({
      sandbox,
      configSha,
      cache,
      baseline: { tests: 9, skipped: 0 },
    });
    expect(second.pass).toBe(false); // the integration branch gained tests since
    expect(sandbox.opened).toHaveLength(2);
  });

  it("gates again when the configuration differs, and never reuses a failure", async () => {
    const configSha = repoWithGate([{ name: "test", run: "sh -c 'exit 1'" }]);
    const sandbox = new FakeGateSandbox(repo.dir);
    const cache = new GateCache();
    await gate({ sandbox, configSha, cache });
    await gate({ sandbox, configSha, cache });
    expect(sandbox.opened).toHaveLength(2); // a failed result is not cached
    expect(
      cache.get(gitOut(repo.dir, ["rev-parse", "main"]), configSha),
    ).toBeUndefined();
  });
});
