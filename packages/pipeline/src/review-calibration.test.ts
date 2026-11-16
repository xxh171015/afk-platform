import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, gitOrThrow } from "./exec.ts";
import {
  loadAnswers,
  loadSamples,
  runReviewCalibration,
  scoreDefect,
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
const fixtureRoot = join(
  repoRoot,
  "packages/pipeline/src/testing/review-calibration",
);
const tinyDocs = join(fixtureRoot, "samples/tiny");

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
    const samples = loadSamples(fixtureRoot);
    const tiny = samples.find((sample) => sample.name === "tiny");
    expect(tiny?.kind).toBe("ticket");
    expect(tiny?.specMd).toContain("add() to reject negatives");
    expect(tiny?.ticketMd).toContain("Reject negatives");
    expect(tiny?.patch).toContain("skipped the negative check");
    const answers = loadAnswers(join(fixtureRoot, "answers.yaml"));
    expect(
      answers.filter((row) => row.sample === "tiny").map((row) => row.id),
    ).toEqual(["us-1", "st-1", "miss-1"]);
  });
});

describe("the committed real samples", () => {
  it("keeps only five real samples and ten human answers under docs", () => {
    const samples = loadSamples(docsRoot);
    expect(samples.map((sample) => sample.name)).toEqual([
      "s14-backend-batch-ship",
      "s15-backend-note-search",
      "s15-frontend-note-search",
      "s23-push-retry",
      "s28-sandbox-oom",
    ]);
    const answers = loadAnswers(join(docsRoot, "answers.yaml"));
    expect(answers).toHaveLength(10);
    expect(answers.map((row) => row.sample)).not.toContain("tiny");
  });

  it("says fixtures live next to the tests and real samples live under docs", () => {
    const readme = readFileSync(join(docsRoot, "README.md"), "utf8");
    expect(readme).toContain(
      "packages/pipeline/src/testing/review-calibration",
    );
    expect(readme).toContain("docs/review-calibration/samples");
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
      `${readFileSync(join(fixtureRoot, "answers.yaml"), "utf8").trimEnd()}\n# ${SECRET}\n`,
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
      readFileSync(join(fixtureRoot, "answers.yaml")),
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

  it("clones only the base commit so origin/main cannot show the answers file", async () => {
    origin = makeRepo({
      "src/app.ts": BASE_APP,
      "AGENTS.md": "Do not skip tests.\n",
    });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    origin.commit(
      { "docs/review-calibration/answers.yaml": `${SECRET}\n` },
      "answers on main",
    );
    const later = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-clone-"));
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
      readFileSync(join(fixtureRoot, "answers.yaml")),
    );

    const inspections: {
      branches: string;
      shownCode: number;
      shownOut: string;
      laterCode: number;
    }[] = [];
    await runReviewCalibration({
      root,
      makeRunner: (repoDir) => {
        const shown = git(repoDir, [
          "show",
          "origin/main:docs/review-calibration/answers.yaml",
        ]);
        inspections.push({
          branches: git(repoDir, ["branch", "-a"]).stdout,
          shownCode: shown.code,
          shownOut: shown.out,
          laterCode: git(repoDir, ["cat-file", "-t", later]).code,
        });
        return new FakeAgentRunner(repoDir, () => ({
          output: {
            verdict: "pass",
            mustFix: [],
            suggestions: [],
            uncertainties: [],
            sources: ["AGENTS.md"],
          },
        }));
      },
    });

    expect(inspections).toHaveLength(1);
    const clone = inspections[0];
    expect(clone?.branches).not.toMatch(/origin\//);
    expect(clone?.shownCode).not.toBe(0);
    expect(clone?.shownOut).not.toContain(SECRET);
    expect(clone?.laterCode).not.toBe(0);
  });

  it("marks a sample as failed when its clone fails and still scores the others", async () => {
    origin = makeRepo({
      "src/app.ts": BASE_APP,
      "AGENTS.md": "Do not skip tests.\n",
    });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-fail-"));
    dirs.push(root);
    for (const [name, repo] of [
      ["tiny", origin.dir],
      ["broken", "/no/such/calibration-origin"],
    ] as const) {
      const sampleDir = join(root, "samples", name);
      mkdirSync(sampleDir, { recursive: true });
      writeFileSync(
        join(sampleDir, "sample.yaml"),
        [`repo: ${repo}`, `base: ${base}`, "kind: ticket", ""].join("\n"),
      );
      for (const file of ["change.patch", "spec.md", "ticket.md"] as const) {
        writeFileSync(
          join(sampleDir, file),
          readFileSync(join(tinyDocs, file)),
        );
      }
    }
    writeFileSync(
      join(root, "answers.yaml"),
      readFileSync(join(fixtureRoot, "answers.yaml")),
    );

    const table = await runReviewCalibration({
      root,
      makeRunner: (repoDir) =>
        new FakeAgentRunner(repoDir, (ctx) => {
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
          };
        }),
    });

    expect(table).toMatch(/\| broken \| 失败 \|/);
    expect(table).toMatch(/tiny\/us-1/);
    expect(table).toContain("must-fix");
    expect(table).toContain("suggestion");
  });
});

function writeTinySample(root: string, repo: string, base: string): void {
  const sampleDir = join(root, "samples", "tiny");
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(
    join(sampleDir, "sample.yaml"),
    [`repo: ${repo}`, `base: ${base}`, "kind: ticket", ""].join("\n"),
  );
  for (const name of ["change.patch", "spec.md", "ticket.md"] as const) {
    writeFileSync(join(sampleDir, name), readFileSync(join(tinyDocs, name)));
  }
  writeFileSync(
    join(root, "answers.yaml"),
    readFileSync(join(fixtureRoot, "answers.yaml")),
  );
}

describe("runReviewCalibration on a temp dir behind a symlink", () => {
  const savedTmp = process.env.TMPDIR;
  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });

  // macOS: /var/folders is a symlink to /private/var/folders. Git worktrees record the real path, and the
  // sandbox only mounts the path it was given, so the clone must already sit at its real path.
  it("hands the runner the clone's real path", async () => {
    origin = makeRepo({ "src/app.ts": BASE_APP, "AGENTS.md": "x\n" });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-link-"));
    dirs.push(root);
    writeTinySample(root, origin.dir, base);
    const realTmp = join(root, "real-tmp");
    mkdirSync(realTmp);
    const linkTmp = join(root, "link-tmp");
    symlinkSync(realTmp, linkTmp);
    process.env.TMPDIR = linkTmp;

    const seen: string[] = [];
    await runReviewCalibration({
      root,
      makeRunner: (repoDir) => {
        seen.push(repoDir);
        return new FakeAgentRunner(repoDir, () => ({
          output: {
            verdict: "pass",
            mustFix: [],
            suggestions: [],
            uncertainties: [],
            sources: ["AGENTS.md"],
          },
        }));
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(realpathSync(realTmp))).toBe(true);
  });
});

describe("runReviewCalibration when an axis run fails", () => {
  it("shows 运行失败 for that axis and lists the error, not 未发现", async () => {
    origin = makeRepo({ "src/app.ts": BASE_APP, "AGENTS.md": "x\n" });
    const base = gitOrThrow(origin.dir, ["rev-parse", "HEAD"]);
    const root = mkdtempSync(join(tmpdir(), "afk-cal-axisfail-"));
    dirs.push(root);
    writeTinySample(root, origin.dir, base);

    const table = await runReviewCalibration({
      root,
      makeRunner: (repoDir) =>
        new FakeAgentRunner(repoDir, (ctx) => {
          if (ctx.prompt.includes("阶段：review，Spec 轴")) {
            return {
              error: { kind: "other", message: "not a git repository" },
            };
          }
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

    const usRow = table.split("\n").find((line) => line.includes("tiny/us-1"));
    expect(usRow).toMatch(/\| 运行失败 \| 未发现 \|$/);
    expect(table).toMatch(
      /\| tiny \(spec\) \| 失败 \| not a git repository \|/,
    );
  });
});

describe("scoreDefect", () => {
  const defect = { file: "src/orders/model.ts", lines: "155-159" };
  const review = (
    mustFix: { file: string; line?: number; problem: string }[],
    suggestions: string[] = [],
  ) => ({
    verdict: mustFix.length ? ("fix" as const) : ("pass" as const),
    mustFix,
    suggestions,
    scopeCreep: [],
    uncertainties: [],
  });

  // Calibration 2026-11-16: the Spec axis named line 160 for a defect answered as 155-159.
  it("counts a must-fix a few lines outside the answer's range", () => {
    expect(
      scoreDefect(
        defect,
        review([{ file: "src/orders/model.ts", line: 160, problem: "x" }]),
      ),
    ).toBe("must-fix");
    expect(
      scoreDefect(
        defect,
        review([{ file: "src/orders/model.ts", line: 150, problem: "x" }]),
      ),
    ).toBe("must-fix");
  });

  it("does not count a must-fix far from the range or in another file", () => {
    expect(
      scoreDefect(
        defect,
        review([{ file: "src/orders/model.ts", line: 40, problem: "x" }]),
      ),
    ).toBe("未发现");
    expect(
      scoreDefect(
        defect,
        review([{ file: "src/orders/routes.ts", line: 157, problem: "x" }]),
      ),
    ).toBe("未发现");
  });

  it("finds file:line anywhere in a suggestion, not only at its start", () => {
    expect(
      scoreDefect(
        defect,
        review([], ["重复 id 没拦住（`src/orders/model.ts:161`），见契约"]),
      ),
    ).toBe("suggestion");
    expect(
      scoreDefect(defect, review([], ["src/orders/model.ts:90 命名"])),
    ).toBe("未发现");
  });
});
