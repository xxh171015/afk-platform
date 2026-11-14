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
    return /\.(ts|mjs|js|sh|ya?ml)$/.test(path) && !/\.test\.ts$/.test(path)
      ? [path]
      : [];
  });
}

// The root scripts and manifests can run commands too.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const MIN_FILES = 30; // sanity: the scan found the code, not an empty directory

const code = [
  ...sources(packages),
  join(root, "package.json"),
  ...sources(join(root, "scripts")),
].map((file) => ({
  file: relative(packages, file),
  text: readFileSync(file, "utf8"),
}));

describe("the platform's source", () => {
  it("has something to look at", () => {
    expect(code.length).toBeGreaterThan(MIN_FILES);
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
      /enablePullRequestAutoMerge/,
      /["'`]pr["'`]\s*,\s*["'`]merge["'`]/,
      /pulls\[["'`]merge["'`]\]/,
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
    // besides the worker's exit: plat setup --finish, on the person's machine with their credentials, pushing a
    // repo's setup to afk/setup and nothing else (approved by the person, #323)
    expect(pushes).toEqual(["cli/src/setup.ts", "worker/src/push.ts"]);
    const setup = code.find(({ file }) => file === "cli/src/setup.ts");
    expect(setup?.text.match(/["'`]push["'`][^\]]*\]/g)).toEqual([
      expect.stringContaining(
        ["`HEAD:refs/heads/$", "{SETUP_BRANCH}`"].join(""),
      ),
    ]);
  });

  it("has no other way to publish commits: no send-pack, no pushing alias, no push in package scripts", () => {
    const hits = code
      .filter(({ file }) => file !== "worker/src/push.ts")
      .filter(({ text }) =>
        /send-pack|alias\.\w+=push|git\s+push\b(?!\s*`)/.test(
          text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""),
        ),
      )
      .map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it("talks to origin from the worker only through git that does not block the event loop", () => {
    // the synchronous helpers, called with an argument list that reaches origin
    const sync =
      /\b(?:git|gitOrThrow|gitOut)\(\s*[^,()]+,\s*\[([^\]]*)\]|\bexec\(\s*["'`]git["'`],\s*\[([^\]]*)\]/g;
    const remote = (args: string) =>
      /["'`]ls-remote["'`]/.test(args) ||
      (/["'`](?:fetch|push|pull|clone)["'`]/.test(args) &&
        /["'`]origin["'`]|\burl\b/.test(args));
    const hits = code
      .filter(({ file }) => file.startsWith("worker/src/"))
      .flatMap(({ file, text }) =>
        [...text.matchAll(sync)]
          .filter((match) => remote(match[1] ?? match[2] ?? ""))
          .map((match) => `${file}: ${match[0].slice(0, 80)}`),
      );
    expect(hits).toEqual([]);
  });

  it("the push exit lets agent and spec branches through and refuses main", async () => {
    const { pushRef } = await import("./push.ts");
    for (const target of ["refs/heads/main", "main", "refs/heads/master"]) {
      await expect(
        pushRef({ repoDir: ".", source: "HEAD", target }),
      ).rejects.toThrow(RangeError);
    }
  });
});
