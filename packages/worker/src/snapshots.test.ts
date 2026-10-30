import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { pruneSnapshots, SnapshotStore } from "./snapshots.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-snapshots-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoWith(files: Record<string, string>): TestRepo {
  const repo = makeRepo(files);
  cleanups.push(() => repo.cleanup());
  return repo;
}

const sha = (repo: TestRepo) => gitOrThrow(repo.dir, ["rev-parse", "HEAD"]);

describe("a snapshot of a repo at a SHA", () => {
  it("holds the files of that commit, not of what came later, as <name>@<sha>", () => {
    const repo = repoWith({ "src/a.ts": "one\n" });
    const pinned = sha(repo);
    repo.commit({ "src/a.ts": "two\n" }, "later");
    const store = new SnapshotStore(scratch());

    const dir = store.ensure("backend", repo.dir, pinned);

    expect(dir).toBe(join(store.root, `backend@${pinned}`));
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("one\n");
  });

  it("keeps files the repo marks export-ignore, and does not expand export-subst", () => {
    const repo = repoWith({
      ".gitattributes": "secret.txt export-ignore\nversion.txt export-subst\n",
      "secret.txt": "kept\n",
      "version.txt": "$Format:%H$\n",
    });
    const store = new SnapshotStore(scratch());

    const dir = store.ensure("backend", repo.dir, sha(repo));

    expect(readFileSync(join(dir, "secret.txt"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(dir, "version.txt"), "utf8")).toBe(
      "$Format:%H$\n",
    );
  });

  it("is shared by the same SHA: the second ask reuses the directory", () => {
    const repo = repoWith({ "a.txt": "x\n" });
    const store = new SnapshotStore(scratch());
    const first = store.ensure("backend", repo.dir, sha(repo));
    writeFileSync(join(first, "marker"), "from the first");
    expect(store.ensure("backend", repo.dir, sha(repo))).toBe(first);
    expect(existsSync(join(first, "marker"))).toBe(true);
  });

  it("leaves no half directory when the export fails, and works once the SHA is there", () => {
    const repo = repoWith({ "a.txt": "x\n" });
    const store = new SnapshotStore(scratch());
    const missing = "0123456789012345678901234567890123456789";

    expect(() => store.ensure("backend", repo.dir, missing)).toThrow(
      /git archive/,
    );

    expect(readdirSync(store.root)).toEqual([]);
    expect(existsSync(join(store.root, `backend@${missing}`))).toBe(false);
    const good = store.ensure("backend", repo.dir, sha(repo));
    expect(existsSync(join(good, "a.txt"))).toBe(true);
  });
});

describe("pruneSnapshots", () => {
  it("removes snapshots not used for seven days and keeps the rest, using a snapshot counts as using it", () => {
    const repo = repoWith({ "a.txt": "x\n" });
    const store = new SnapshotStore(scratch());
    const current = store.ensure("backend", repo.dir, sha(repo));
    repo.commit({ "a.txt": "y\n" }, "next");
    const old = store.ensure("backend", repo.dir, sha(repo));
    repo.commit({ "a.txt": "z\n" }, "third");
    const stale = store.ensure("backend", repo.dir, sha(repo));
    const eightDays = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, eightDays, eightDays);
    utimesSync(stale, eightDays, eightDays);

    // asking for it again is using it
    store.ensure(
      "backend",
      repo.dir,
      gitOrThrow(repo.dir, ["rev-parse", "HEAD~1"]),
    );
    const removed = pruneSnapshots(store.root, 7 * 24 * 3600 * 1000);

    expect(removed).toEqual([stale]);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("does nothing when there is no snapshot directory yet", () => {
    expect(pruneSnapshots(join(scratch(), "nope"), 1000)).toEqual([]);
  });
});
