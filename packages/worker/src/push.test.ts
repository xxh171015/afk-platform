import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOut } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushRef } from "./push.ts";

let local: TestRepo;
let remoteRoot: string;
let remote: string;

beforeEach(() => {
  local = makeRepo();
  remoteRoot = mkdtempSync(join(tmpdir(), "afk-remote-"));
  remote = join(remoteRoot, "origin.git");
  git(remoteRoot, ["clone", "--quiet", "--bare", local.dir, remote]);
  git(local.dir, ["remote", "add", "origin", remote]);
});
afterEach(() => {
  local.cleanup();
  rmSync(remoteRoot, { recursive: true, force: true });
});

// A new branch is pushed with an expected-old that says it must not exist yet.
const push = (
  target: string,
  over: Partial<Parameters<typeof pushRef>[0]> = {},
) =>
  pushRef({
    repoDir: local.dir,
    source: "HEAD",
    target,
    expectedOld: "",
    ...over,
  });
const remoteHas = (ref: string) =>
  git(remote, ["rev-parse", "--verify", "--quiet", ref]).code === 0;

describe("the push exit", () => {
  it.each([
    "refs/heads/agent/T-1",
    "refs/heads/spec/order-export",
    "refs/heads/spec/team/order-export",
    "refs/heads/agent/T-1.v2",
  ])("lets %s through", (target) => {
    expect(push(target)).toEqual({ ok: true });
    expect(remoteHas(target)).toBe(true);
  });

  it.each([
    "refs/heads/main",
    "refs/heads/master",
    "refs/heads/develop",
    "refs/heads/agentx/T-1",
    "refs/heads/agent",
    "refs/heads/agent/",
    "refs/heads/agent//T-1",
    "refs/heads/agent/T-1/",
    "refs/heads/agent/../main",
    "refs/heads/agent/T-1.lock",
    "refs/tags/agent/T-1",
    "refs/heads/spec/..",
    "agent/T-1", // not a full ref
    "refs/heads/spec/x y",
  ])("refuses %s, and nothing reaches the remote", (target) => {
    const before = gitOut(remote, ["for-each-ref"]);
    expect(() => push(target)).toThrow(RangeError);
    expect(gitOut(remote, ["for-each-ref"])).toBe(before);
  });

  it("refuses to move a branch without saying where it is expected to be", () => {
    expect(() =>
      pushRef({
        repoDir: local.dir,
        source: "HEAD",
        target: "refs/heads/spec/s",
      }),
    ).toThrow(/without the SHA/);
    expect(() =>
      pushRef({
        repoDir: local.dir,
        source: "HEAD",
        target: "refs/heads/agent/T-1",
      }),
    ).toThrow(/without the SHA/);
    expect(remoteHas("refs/heads/spec/s")).toBe(false);
    expect(remoteHas("refs/heads/agent/T-1")).toBe(false);
  });

  it('an expected-old of "" means the branch must not exist yet', () => {
    expect(push("refs/heads/spec/s")).toEqual({ ok: true });
    local.commit({ "x.txt": "x\n" }, "second");
    expect(push("refs/heads/spec/s").ok).toBe(false);
    expect(push("refs/heads/agent/T-1")).toEqual({ ok: true });
    local.commit({ "y.txt": "y\n" }, "agent second");
    expect(push("refs/heads/agent/T-1").ok).toBe(false);
  });

  it("never deletes: an empty source is refused", () => {
    push("refs/heads/agent/T-1");
    expect(() => push("refs/heads/agent/T-1", { source: "" })).toThrow(
      /refusing to push from/,
    );
    expect(remoteHas("refs/heads/agent/T-1")).toBe(true);
  });

  it("only takes a plain commit or ref as the source, not a refspec or an option", () => {
    expect(() =>
      push("refs/heads/agent/T-1", { source: "HEAD:refs/heads/main" }),
    ).toThrow(/refusing to push from/);
    expect(() => push("refs/heads/agent/T-1", { source: "--delete" })).toThrow(
      /refusing to push from/,
    );
  });

  it("only pushes to origin", () => {
    expect(() => push("refs/heads/agent/T-1", { remote: "evil" })).toThrow(
      /only origin/,
    );
  });

  it("with --force-with-lease, refuses to overwrite a branch that moved meanwhile", () => {
    push("refs/heads/spec/s");
    const first = gitOut(local.dir, ["rev-parse", "HEAD"]);
    local.commit({ "x.txt": "x\n" }, "second");
    expect(push("refs/heads/spec/s", { expectedOld: first })).toEqual({
      ok: true,
    });
    local.commit({ "y.txt": "y\n" }, "third");
    const stale = push("refs/heads/spec/s", { expectedOld: first });
    expect(stale.ok).toBe(false);
  });

  it("reports a failed push instead of throwing, and leaves tokens out of the message", () => {
    const result = push("refs/heads/agent/T-1", { remote: undefined });
    expect(result.ok).toBe(true);
    git(local.dir, [
      "remote",
      "set-url",
      "origin",
      join(remoteRoot, "missing.git"),
    ]);
    const failed = pushRef(
      {
        repoDir: local.dir,
        source: "HEAD",
        target: "refs/heads/agent/T-2",
        expectedOld: "",
      },
      { token: "s3cret-token" },
    );
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("s3cret-token");
  });
});
