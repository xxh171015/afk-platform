import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// The detection workflow template (docs/specs/m1-platform.md「推送出口与检测」). The workflow's script runs here
// for real, with a stand-in for `gh` that answers from fixtures and records the issues it is asked to open.

const template = fileURLToPath(
  new URL("../templates/afk-main-guard.yml", import.meta.url),
);
const workflow = parse(readFileSync(template, "utf8")) as {
  on: { push: { branches: string[] } } & Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { guard: { steps: { env: Record<string, string>; run: string }[] } };
};
const step = workflow.jobs.guard.steps[0] as {
  env: Record<string, string>;
  run: string;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afk-guard-"));
  const gh = join(dir, "gh");
  // Answers only the one endpoint the workflow should ask, so a wrong path fails the test.
  writeFileSync(
    gh,
    `#!/bin/sh
case "$1 $2" in
  "api repos/acme/backend/commits/"*"/pulls")
    sha=$(echo "$2" | sed 's|.*/commits/||; s|/pulls||')
    count=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0)
    echo $((count + 1)) > "$FAKE_COUNTER"
    [ "$FAKE_API_FAIL" = "1" ] && { echo "HTTP 403" >&2; exit 1; }
    if [ "$count" -lt "$FAKE_EMPTY_FIRST" ]; then echo "[]";
    elif [ -f "$FAKE_DIR/pulls-$sha.json" ]; then cat "$FAKE_DIR/pulls-$sha.json";
    else cat "$FAKE_PULLS"; fi ;;
  "api repos/acme/backend/compare/"*)
    if [ -f "$FAKE_DIR/compare.json" ]; then cat "$FAKE_DIR/compare.json"; else echo "HTTP 404" >&2; exit 1; fi ;;
  "issue list") cat "$FAKE_DIR/existing.json" ;;
  "issue create") echo "$@" >> "$FAKE_ISSUES" ;;
  *) echo "unexpected gh call: $@" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SHA = "0123456789abcdef0123456789abcdef01234567";

function guard(options: {
  pulls: unknown;
  actor?: string;
  pusher?: string;
  emptyFirst?: number; // answers with no pull requests this many times first, like a link that is not there yet
  apiFails?: boolean;
  before?: string; // the commit the push started from
  commits?: string[]; // what the compare call lists, when the range is known
  pullsOf?: Record<string, unknown>; // pull requests of particular commits
  existingIssues?: number; // open issues that already have the title
}) {
  writeFileSync(join(dir, "pulls.json"), JSON.stringify(options.pulls));
  writeFileSync(join(dir, "issues.log"), "");
  writeFileSync(join(dir, "counter"), "0");
  writeFileSync(
    join(dir, "existing.json"),
    JSON.stringify(
      Array.from({ length: options.existingIssues ?? 0 }, (_, i) => ({
        number: i + 1,
      })),
    ),
  );
  if (options.commits) {
    writeFileSync(
      join(dir, "compare.json"),
      JSON.stringify({ commits: options.commits.map((sha) => ({ sha })) }),
    );
  }
  for (const [sha, pulls] of Object.entries(options.pullsOf ?? {})) {
    writeFileSync(join(dir, `pulls-${sha}.json`), JSON.stringify(pulls));
  }
  const result = spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      REPO: "acme/backend",
      SHA,
      RETRY_DELAY: "0",
      FAKE_SHA: SHA,
      FAKE_DIR: dir,
      BEFORE: options.before ?? "",
      FAKE_COUNTER: join(dir, "counter"),
      FAKE_EMPTY_FIRST: String(options.emptyFirst ?? 0),
      FAKE_API_FAIL: options.apiFails ? "1" : "0",
      ACTOR: options.actor ?? "ada",
      PUSHER: options.pusher ?? "ada",
      FAKE_PULLS: join(dir, "pulls.json"),
      FAKE_ISSUES: join(dir, "issues.log"),
    },
  });
  return {
    code: result.status,
    issues: readFileSync(join(dir, "issues.log"), "utf8"),
    asked: Number(readFileSync(join(dir, "counter"), "utf8")),
    stderr: result.stderr,
  };
}

const mergedPr = { merged_at: "2026-10-28T10:00:00Z", base: { ref: "main" } };

describe("the workflow's script", () => {
  it("passes a commit that came in through a merged pull request, pushed by a person", () => {
    expect(guard({ pulls: [mergedPr] })).toMatchObject({ code: 0, issues: "" });
  });

  it("fails and opens an issue when no pull request is associated with the commit", () => {
    const result = guard({ pulls: [] });
    expect(result.code).toBe(1);
    expect(result.issues).toContain("issue create --repo acme/backend");
    expect(result.issues).toContain("Direct push to main: 0123456");
    expect(result.issues).toContain("no merged pull request");
  });

  it("fails when the pull request was never merged", () => {
    const result = guard({
      pulls: [{ merged_at: null, base: { ref: "main" } }],
    });
    expect(result.code).toBe(1);
    expect(result.issues).toContain("no merged pull request");
  });

  it("waits for the commit-to-pull-request link that GitHub has not made yet", () => {
    const result = guard({ pulls: [mergedPr], emptyFirst: 2 });
    expect(result).toMatchObject({ code: 0, issues: "", asked: 3 });
  });

  it("gives up after a few tries and then says there is no pull request", () => {
    const result = guard({ pulls: [mergedPr], emptyFirst: 99 });
    expect(result).toMatchObject({ code: 1, asked: 4 });
    expect(result.issues).toContain("no merged pull request");
  });

  it("opens an issue when GitHub cannot be asked at all, instead of dying silently", () => {
    const result = guard({ pulls: [], apiFails: true });
    expect(result.code).toBe(1);
    expect(result.issues).toContain("GitHub could not be asked");
  });

  it("fails when the merged pull request was for another branch", () => {
    expect(
      guard({
        pulls: [
          { merged_at: "2026-10-28T10:00:00Z", base: { ref: "develop" } },
        ],
      }).code,
    ).toBe(1);
  });

  it("fails when a bot pushed, even if a merged pull request exists", () => {
    const result = guard({
      pulls: [mergedPr],
      actor: "afk-platform[bot]",
      pusher: "afk-platform[bot]",
    });
    expect(result.code).toBe(1);
    expect(result.issues).toContain("pushed by a bot account");
    expect(result.issues).not.toContain("no merged pull request");
  });

  it("reports both problems in one issue", () => {
    const result = guard({ pulls: [], actor: "x[bot]", pusher: "x[bot]" });
    expect(result.issues).toContain("pushed by a bot account");
    expect(result.issues).toContain("no merged pull request");
    expect(result.issues.match(/issue create/g)).toHaveLength(1);
  });
});

describe("a push of several commits", () => {
  const [a, b, c] = ["a".repeat(40), "b".repeat(40), SHA];
  const before = "9".repeat(40);

  it("passes when every commit of the push belongs to a merged pull request", () => {
    const result = guard({ pulls: [mergedPr], before, commits: [a, b, c] });
    expect(result).toMatchObject({ code: 0, issues: "", asked: 3 });
  });

  it("fails when an earlier commit of the push has no pull request, even though the newest has", () => {
    const result = guard({
      pulls: [mergedPr],
      pullsOf: { [b]: [] },
      before,
      commits: [a, b, c],
    });
    expect(result.code).toBe(1);
    expect(result.issues).toContain(
      "no merged pull request is associated with: bbbbbbb",
    );
    expect(result.issues).not.toContain("aaaaaaa");
  });

  it("looks at the newest commit only for a new branch, where there is no range", () => {
    const result = guard({
      pulls: [mergedPr],
      before: "0".repeat(40),
      commits: [a, b, c],
    });
    expect(result).toMatchObject({ code: 0, asked: 1 });
  });

  it("looks at the newest commit only when the range cannot be had", () => {
    const result = guard({ pulls: [mergedPr], before }); // no compare answer: the call fails
    expect(result).toMatchObject({ code: 0, asked: 1 });
  });
});

describe("a push that was already reported", () => {
  it("fails again but does not open a second issue", () => {
    const result = guard({ pulls: [], existingIssues: 1 });
    expect(result.code).toBe(1);
    expect(result.issues).toBe("");
  });

  it("opens the issue when there is none yet", () => {
    expect(guard({ pulls: [], existingIssues: 0 }).issues).toContain(
      "issue create",
    );
  });
});

describe("the workflow's shape", () => {
  it("runs on pushes to main and nothing else", () => {
    expect(Object.keys(workflow.on)).toEqual(["push"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
  });

  it("asks for the least it needs: read contents and pull requests, write issues", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      issues: "write",
    });
  });

  it("does not use the GitHub App's credentials or any secret", () => {
    expect(readFileSync(template, "utf8")).not.toMatch(/secrets\./);
  });
});
