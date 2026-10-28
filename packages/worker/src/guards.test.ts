import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guarantees about the platform's code as a whole (docs/specs/m1-platform.md「推送出口与检测」): it never merges
// a pull request and never pushes except through the one exit function. Checked on the source, so a change that
// breaks them fails here and not in production.

const packages = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "drizzle")
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mjs|js|sh)$/.test(path) && !/\.test\.ts$/.test(path)
      ? [path]
      : [];
  });
}

const code = sources(packages).map((file) => ({
  file: relative(packages, file),
  text: readFileSync(file, "utf8"),
}));

describe("the platform's source", () => {
  it("has something to look at", () => {
    expect(code.length).toBeGreaterThan(30);
  });

  it("never merges a pull request, through any API or CLI", () => {
    const merging = [
      /pulls\/[^\s"'`]*\/merge/i,
      /\/merge["'`]/,
      /merge_pull_request/i,
      /mergePullRequest/i,
      /enable_?auto_?merge/i,
      /gh\s+pr\s+merge/i,
      /\bpulls\.merge\b/,
    ];
    const hits = code.flatMap(({ file, text }) =>
      merging
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${file}: ${pattern}`),
    );
    expect(hits).toEqual([]);
  });

  it("runs `git push` only in the push exit", () => {
    const pushes = code
      .filter(({ text }) => /["'`]push["'`]/.test(text))
      .map(({ file }) => file);
    expect(pushes).toEqual(["worker/src/push.ts"]);
  });

  it("does not shell out to push either", () => {
    const shellPushes = code
      .filter(({ text }) =>
        /git\s+push/.test(text.replace(/\/\/.*$/gm, "").replace(/\*.*$/gm, "")),
      )
      .map(({ file }) => file);
    expect(shellPushes).toEqual([]);
  });

  it("the push exit refuses main", async () => {
    const { pushRef } = await import("./push.ts");
    for (const target of ["refs/heads/main", "main", "refs/heads/master"]) {
      expect(() => pushRef({ repoDir: ".", source: "HEAD", target })).toThrow(
        RangeError,
      );
    }
  });
});
