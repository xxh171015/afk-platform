import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCheckResultBundle } from "./check-result-bundle.ts";

// The self-check command as the agent runs it: a bundled .mjs, invoked with real node.

let checker = "";
const dirs: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-check-result-"));
  dirs.push(dir);
  checker = join(dir, "check-result.mjs");
  await writeCheckResultBundle(checker);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function check(stage: string, payload: unknown, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "afk-result-json-"));
  dirs.push(dir);
  const file = join(dir, "result.json");
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return spawnSync(process.execPath, [checker, ...extra, stage, file], {
    encoding: "utf8",
  });
}

const outputOf = (result: ReturnType<typeof spawnSync>) =>
  `${result.stdout}${result.stderr}`;

const run577 = {
  status: "done",
  summary: "did it",
  acceptance: { "returns csv": ["csv test"] },
  decisions: [
    { kind: "choice", text: "named it export" },
    {
      kind: "conflict",
      text: "ticket said one file; tdd needed a test file; added the test",
    },
    { kind: "known-gap", text: "list reload skips the note filter" },
    { kind: "deferred", text: "openapi extra field", ref: "new" },
    {
      kind: "workaround",
      text: "skipped drizzle generate",
      ref: "91813f8",
    },
  ],
};

const run655 = {
  verdict: "pass",
  mustFix: [],
  suggestions: [{ file: "a.ts", line: 338, problem: "weaker" }],
  scopeCreep: [{ file: "b.tsx", line: 940, problem: "extra" }],
  uncertainties: [],
};

describe("the result self-check command", () => {
  it("rejects Run 577's workaround ref without normalizing, naming decisions.4.ref", () => {
    const result = check("implement", run577, ["--no-normalize"]);
    expect(result.status).not.toBe(0);
    expect(outputOf(result)).toContain("decisions.4.ref");
  });

  it("rejects Run 655's object suggestions and scopeCreep without normalizing", () => {
    const result = check("recheck", run655, ["--no-normalize"]);
    expect(result.status).not.toBe(0);
    expect(outputOf(result)).toContain("suggestions.0");
    expect(outputOf(result)).toContain("scopeCreep.0");
  });

  it("accepts Run 577 and Run 655 when normalizing", () => {
    expect(check("implement", run577).status).toBe(0);
    expect(check("recheck", run655).status).toBe(0);
  });

  it("still rejects a passing review that has must-fix items when normalizing", () => {
    const result = check("recheck", {
      verdict: "pass",
      mustFix: [{ file: "a.ts", problem: "bug" }],
      suggestions: [],
      uncertainties: [],
    });
    expect(result.status).not.toBe(0);
  });

  it("accepts the corrected Run 577 and Run 655 writings", () => {
    const corrected577 = {
      ...run577,
      decisions: run577.decisions.map((item) =>
        item.kind === "workaround"
          ? { kind: item.kind, text: item.text }
          : item,
      ),
    };
    const corrected655 = {
      ...run655,
      suggestions: ["a.ts:338 weaker"],
      scopeCreep: ["b.tsx:940 extra"],
    };
    expect(check("implement", corrected577).status).toBe(0);
    expect(check("recheck", corrected655).status).toBe(0);
  });

  it("recognizes every stage that has a result schema, and lists them when the name is unknown", () => {
    const valid: Record<string, unknown> = {
      implement: {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      "gate-fix": {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      "review-fix": {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      "merge-fix": {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      "final-fix": {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      rework: {
        status: "done",
        summary: "did it",
        comments: [{ id: "C-12", outcome: "addressed", reply: "fixed" }],
        acceptance: {},
        decisions: [],
      },
      "update-branch": {
        status: "done",
        summary: "did it",
        acceptance: {},
        decisions: [],
      },
      review: {
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      },
      "final-review": {
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      },
      recheck: {
        verdict: "pass",
        mustFix: [],
        suggestions: [],
        uncertainties: [],
      },
      "final-tidy": {
        status: "done",
        summary: "tidied",
        tidied: [],
        skipped: [],
        decisions: [],
      },
      diagnose: {
        result: "pass",
        failingRepo: null,
        evidence: "e2e passed",
        failingTests: [],
      },
      "locate-bug": {
        result: "unlocated",
        repo: "backend",
        files: [],
        evidence: "no match",
        reproduction: "",
      },
    };
    for (const [stage, payload] of Object.entries(valid)) {
      expect(check(stage, payload).status, stage).toBe(0);
    }
    const unknown = check("not-a-stage", {});
    expect(unknown.status).not.toBe(0);
    const listed = outputOf(unknown);
    for (const stage of Object.keys(valid)) {
      expect(listed).toContain(stage);
    }
  });

  it("rejects a rework result that does not cover every comment id in the context", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-rework-ctx-"));
    dirs.push(dir);
    mkdirSync(join(dir, "context"));
    writeFileSync(
      join(dir, "context", "review-comments.json"),
      `${JSON.stringify({
        changeRequest: 1,
        currentHead: "abc",
        comments: [
          { id: "C-12", body: "empty list" },
          { id: "C-14", body: "repeatable" },
        ],
      })}\n`,
    );
    const file = join(dir, "result.json");
    writeFileSync(
      file,
      `${JSON.stringify({
        status: "done",
        summary: "did it",
        comments: [{ id: "C-12", outcome: "addressed", reply: "fixed" }],
        acceptance: {},
        decisions: [],
      })}\n`,
    );
    const result = spawnSync(process.execPath, [checker, "rework", file], {
      encoding: "utf8",
      cwd: dir,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("C-14");
  });

  it("is a single file that does not import platform packages", () => {
    const text = readFileSync(checker, "utf8");
    expect(text).not.toMatch(/from ["']zod["']/);
    expect(text).not.toMatch(/from ["']@afk\//);
  });

  it("is bundled at worker start and mounted on every agent sandbox", () => {
    const main = readFileSync(
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "utf8",
    );
    expect(main).toContain("writeCheckResultBundle");
    expect(main).toContain("checkResultMount");
  });
});
