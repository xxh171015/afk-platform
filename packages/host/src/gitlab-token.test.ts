import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitLabTokenSource } from "./gitlab-token.ts";

const repo = { owner: "me", name: "pilot", host: "git.example" };
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afk-gitlab-token-"));
  path = join(dir, "git.example");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string, mode = 0o600) => {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
};

describe("a GitLab PAT file", () => {
  it("hands back the token, trimming the newline, and ignores the permissions asked for", async () => {
    write("glpat-one\n");
    const tokens = createGitLabTokenSource({ path });
    expect(
      await tokens.tokenFor({
        repo,
        permissions: { contents: "write", pull_requests: "write" },
      }),
    ).toBe("glpat-one");
    expect(
      await tokens.tokenFor({ repo, permissions: { contents: "read" } }),
    ).toBe("glpat-one");
  });

  it("reads the file again on the next call, so replacing it is enough", async () => {
    write("glpat-old\n");
    const tokens = createGitLabTokenSource({ path });
    expect(await tokens.tokenFor({ repo, permissions: {} })).toBe("glpat-old");
    write("glpat-new\n");
    expect(await tokens.tokenFor({ repo, permissions: {} })).toBe("glpat-new");
  });

  it("refuses a file other people can read", async () => {
    write("glpat-one\n", 0o644);
    await expect(
      createGitLabTokenSource({ path }).tokenFor({ repo, permissions: {} }),
    ).rejects.toThrow(/chmod 600/);
  });

  it("refuses an empty file", async () => {
    write("\n");
    await expect(
      createGitLabTokenSource({ path }).tokenFor({ repo, permissions: {} }),
    ).rejects.toThrow(/empty/);
  });
});
