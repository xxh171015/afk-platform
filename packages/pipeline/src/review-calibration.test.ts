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
import { afterEach, describe, expect, it } from "vitest";
import { gitOrThrow } from "./exec.ts";
import {
  loadAnswers,
  loadSamples,
  runReviewCalibration,
} from "./review-calibration.ts";
import { FakeAgentRunner } from "./testing/fakes.ts";
import { makeRepo, type TestRepo } from "./testing/repo.ts";

let origin: TestRepo | undefined;
const dirs: string[] = [];
afterEach(() => {
  origin?.cleanup();
  origin = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const docsRoot = join(repoRoot, "docs/review-calibration");
const tinyDocs = join(docsRoot, "samples/tiny");

const BASE_APP = [
  "export function greet(name: string): string {",
  '  return "hello " + name;',
  "}",
  "",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const SECRET = "SECRET_ANSWER_MARKER";

function usageLine(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: "result",
    usage: { inputTokens, outputTokens },
  });
}

describe("the committed tiny sample", () => {
  it("has ticket kind, a spec, a ticket, a patch, and three answers", () => {
    const samples = loadSamples(docsRoot);
    const tiny = samples.find((sample) => sample.name === "tiny");
    expect(tiny?.kind).toBe("ticket");
    expect(tiny?.specMd).toContain("add() to reject negatives");
    expect(tiny?.ticketMd).toContain("Reject negatives");
    expect(tiny?.patch).toContain("skipped the negative check");
    const answers = loadAnswers(join(docsRoot, "answers.yaml"));
    expect(answers.map((row) => row.id)).toEqual(["us-1", "st-1", "miss-1"]);
  });
});

describe("runReviewCalibration", () => {
  it("scores a sample with a fake runner into must-fix, suggestion, and 未发现, with token usage", async () => {
    origin = makeRepo({
      "src/app.ts": BASE_APP,
      "AGENTS.md": "Do not skip tests.\n",
    });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-"));
    dirs.push(root);
    const sampleDir = join(root, "samples", "tiny");
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, "sample.yaml"),
      [`repo: ${origin.dir}`, `base: ${base}`, "kind: ticket", ""].join("\n"),
    );
    for (const name of ["change.patch", "spec.md", "ticket.md"] as const) {
      writeFileSync(join(sampleDir, name), readFileSync(join(tinyDocs, name)));
    }
    writeFileSync(
      join(root, "answers.yaml"),
      `${readFileSync(join(docsRoot, "answers.yaml"), "utf8").trimEnd()}\n# ${SECRET}\n`,
    );

    const seenSecrets: string[] = [];
    const table = await runReviewCalibration({
      root,
      models: { spec: "spec-model", standards: "std-model" },
      makeRunner: (repoDir) =>
        new FakeAgentRunner(repoDir, (ctx) => {
          const blob = `${ctx.prompt}\n${ctx.context("ticket.md") ?? ""}\n${ctx.context("spec.md") ?? ""}\n${ctx.context("answers.yaml") ?? ""}`;
          if (blob.includes(SECRET)) seenSecrets.push(ctx.prompt.slice(0, 80));
          const spec = ctx.prompt.includes("阶段：review，Spec 轴");
          if (spec) {
            return {
              output: {
                verdict: "fix",
                mustFix: [
                  {
                    file: "src/app.ts",
                    line: 6,
                    problem: "add() does not reject negatives",
                  },
                ],
                suggestions: [],
                uncertainties: [],
              },
              rawLines: [usageLine(10, 4)],
            };
          }
          return {
            output: {
              verdict: "pass",
              mustFix: [],
              suggestions: [
                "src/app.ts:10 skip leftover should be a running test",
              ],
              uncertainties: [],
              sources: ["AGENTS.md"],
            },
            rawLines: [usageLine(8, 3)],
          };
        }),
    });

    expect(seenSecrets).toEqual([]);
    expect(table).toContain("must-fix");
    expect(table).toContain("suggestion");
    expect(table).toContain("未发现");
    expect(table).toMatch(/us-1/);
    expect(table).toMatch(/st-1/);
    expect(table).toMatch(/miss-1/);
    expect(table).toContain("spec-model");
    expect(table).toContain("std-model");
    expect(table).toContain("inputTokens 10");
    expect(table).toContain("inputTokens 8");
  });

  it("runs final-review prompts when the sample kind is final", async () => {
    origin = makeRepo({
      "src/app.ts": BASE_APP,
      "AGENTS.md": "Do not skip tests.\n",
    });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-final-"));
    dirs.push(root);
    const sampleDir = join(root, "samples", "tiny");
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, "sample.yaml"),
      [`repo: ${origin.dir}`, `base: ${base}`, "kind: final", ""].join("\n"),
    );
    writeFileSync(
      join(sampleDir, "change.patch"),
      readFileSync(join(tinyDocs, "change.patch")),
    );
    writeFileSync(
      join(sampleDir, "spec.md"),
      readFileSync(join(tinyDocs, "spec.md")),
    );
    writeFileSync(
      join(root, "answers.yaml"),
      readFileSync(join(docsRoot, "answers.yaml")),
    );
    const stages: string[] = [];
    await runReviewCalibration({
      root,
      makeRunner: (repoDir) =>
        new FakeAgentRunner(repoDir, (ctx) => {
          stages.push(ctx.stage);
          return {
            output: {
              verdict: "pass",
              mustFix: [],
              suggestions: [],
              uncertainties: [],
              sources: ["AGENTS.md"],
            },
          };
        }),
    });
    expect(new Set(stages)).toEqual(new Set(["final-review"]));
    expect(stages).toHaveLength(2);
  });
});
