import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOut } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  processAlive,
  retrieveResult,
  type Slot,
  SlotManager,
  type SlotTask,
} from "./slots.ts";

let main: TestRepo;
let root: string;
let salvageDir: string;
let held: Set<string>; // "job:attempt" the fake API still considers held
let logs: string[];

beforeEach(() => {
  main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  const base = mkdtempSync(join(tmpdir(), "afk-slots-"));
  root = join(base, "slots");
  salvageDir = join(base, "salvage");
  held = new Set();
  logs = [];
});
afterEach(() => {
  main.cleanup();
  rmSync(join(root, ".."), { recursive: true, force: true });
});

const manager = (
  count = 2,
  over: Partial<ConstructorParameters<typeof SlotManager>[0]> = {},
) =>
  new SlotManager({
    root,
    count,
    mainCloneFor: () => main.dir,
    salvageDir,
    isHeld: async (job, attempt) => held.has(`${job}:${attempt}`),
    log: (line) => logs.push(line),
    ...over,
  });

const task = (jobId: number, attempt = 1): SlotTask => ({
  jobId,
  attempt,
  repo: "backend",
  ref: `agent/T-${jobId}`,
});
const acquire = async (m: SlotManager, t: SlotTask) => {
  held.add(`${t.jobId}:${t.attempt}`);
  return (await m.acquire(t)) as Slot;
};
const lockOf = (index: number) =>
  JSON.parse(readFileSync(join(root, String(index), "lock"), "utf8"));

// A pid that belonged to a process that has since exited.
function deadPid(): number {
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.pid))"],
    { encoding: "utf8" },
  );
  return Number(child.stdout);
}

describe("acquiring a slot", () => {
  it("clones the main clone into the slot, without hardlinks", async () => {
    const slot = await acquire(manager(), task(1));
    expect(slot.dir).toBe(join(root, "0", "backend"));
    expect(readFileSync(join(slot.dir, "src/a.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(gitOut(slot.dir, ["rev-parse", "HEAD"])).toBe(
      gitOut(main.dir, ["rev-parse", "HEAD"]),
    );
    // --no-hardlinks: no object file is shared with the main clone, so nothing in the slot can change it
    const objects = join(slot.dir, ".git", "objects");
    const files = readdirSync(objects, {
      recursive: true,
      withFileTypes: true,
    }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(statSync(join(file.parentPath, file.name)).nlink).toBe(1);
    expect(existsSync(join(objects, "info", "alternates"))).toBe(false);
  });

  it("writes an O_EXCL lock with the job, attempt and process id", async () => {
    await acquire(manager(), task(7, 3));
    expect(lockOf(0)).toEqual({
      jobId: 7,
      attempt: 3,
      repo: "backend",
      ref: "agent/T-7",
      pid: process.pid,
    });
  });

  it("hands out as many slots as the concurrency limit, each in its own place", async () => {
    const m = manager(2);
    const a = await acquire(m, task(1));
    const b = await acquire(m, task(2));
    expect([a.index, b.index]).toEqual([0, 1]);
    expect(a.dir).not.toBe(b.dir);
    expect(await m.acquire(task(3))).toBeUndefined();
  });

  it("only one of several racing callers gets the last slot", async () => {
    held.add("1:1");
    held.add("2:1");
    held.add("3:1");
    const m = manager(1);
    const results = await Promise.all([
      m.acquire(task(1)),
      m.acquire(task(2)),
      m.acquire(task(3)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("two managers sharing a directory cannot both take the same slot", async () => {
    held.add("1:1");
    held.add("2:1");
    const results = await Promise.all([
      manager(1).acquire(task(1)),
      manager(1).acquire(task(2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("takes the branch of a spec that carries its database's id as a ticket branch too", async () => {
    const slot = await acquire(manager(), {
      ...task(1),
      ref: "agent/a1b2c3/T-1",
    });
    expect(slot.dir).toContain(root);
  });

  it("refuses a ref that is not a ticket branch", async () => {
    await expect(
      manager().acquire({ ...task(1), ref: "main" }),
    ).rejects.toThrow(/not a ticket branch/);
    await expect(
      manager().acquire({ ...task(1), ref: "agent/T-1; rm -rf /" }),
    ).rejects.toThrow(/not a ticket branch/);
  });
});

describe("releasing", () => {
  it("deletes the clone and frees the slot after a success", async () => {
    const m = manager(1);
    const slot = await acquire(m, task(1));
    await slot.release("success");
    expect(existsSync(slot.dir)).toBe(false);
    expect(existsSync(join(root, "0", "lock"))).toBe(false);
    expect(existsSync(join(root, "0", "last.json"))).toBe(false);
    expect(await acquire(m, task(2))).toBeDefined();
  });

  it("keeps the clone after a failure, frees the slot, and rebuilds the clone at the next use", async () => {
    const m = manager(1);
    const slot = await acquire(m, task(1));
    writeFileSync(join(slot.dir, "leftover.txt"), "mess\n");
    await slot.release("failure");
    expect(existsSync(join(slot.dir, "leftover.txt"))).toBe(true); // kept for a look
    expect(existsSync(join(root, "0", "lock"))).toBe(false);

    const next = await acquire(m, task(2));
    expect(next.index).toBe(0);
    expect(existsSync(join(next.dir, "leftover.txt"))).toBe(false); // a fresh clone
  });

  it("releases only its own lock", async () => {
    const m = manager(1);
    const slot = await acquire(m, task(1));
    writeFileSync(
      join(root, "0", "lock"),
      JSON.stringify({ ...task(9), pid: process.pid }),
    );
    await slot.release("success");
    expect(existsSync(join(root, "0", "lock"))).toBe(true);
  });
});

describe("zombie slots", () => {
  async function abandoned(
    options: { commit?: boolean; dirty?: boolean; pid?: number } = {},
  ) {
    const m = manager(1);
    const slot = await acquire(m, task(1));
    if (options.commit) {
      git(slot.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
      writeFileSync(join(slot.dir, "done.ts"), "export {};\n");
      git(slot.dir, ["add", "-A"]);
      git(slot.dir, [
        "-c",
        "user.name=A",
        "-c",
        "user.email=a@b",
        "commit",
        "--quiet",
        "-m",
        "agent work",
      ]);
    }
    if (options.dirty)
      writeFileSync(join(slot.dir, "unfinished.ts"), "const half = \n");
    if (options.pid !== undefined) {
      writeFileSync(
        join(root, "0", "lock"),
        JSON.stringify({ ...task(1), pid: options.pid }),
      );
    }
    return slot;
  }

  it("a lock whose process is dead is reclaimed", async () => {
    await abandoned({ pid: deadPid() });
    const next = await acquire(manager(1), task(2));
    expect(next).toBeDefined();
    expect(lockOf(0).jobId).toBe(2);
  });

  it("a lock the API says has expired is reclaimed even though the process lives", async () => {
    await abandoned();
    held.delete("1:1");
    expect(await acquire(manager(1), task(2))).toBeDefined();
  });

  it("a lock whose process lives and whose lease is held is left alone", async () => {
    await abandoned();
    expect(await manager(1).acquire(task(2))).toBeUndefined();
    expect(lockOf(0).jobId).toBe(1);
  });

  it("takes back the extra commits first", async () => {
    await abandoned({ commit: true, pid: deadPid() });
    expect(
      git(main.dir, ["rev-parse", "--verify", "--quiet", "agent/T-1"]).code,
    ).not.toBe(0);
    await acquire(manager(1), task(2));
    expect(gitOut(main.dir, ["show", "agent/T-1:done.ts"])).toBe("export {};");
  });

  it("removes the sandboxes still running on the zombie's slot before anything of its is touched", async () => {
    const slot = await abandoned({ commit: true, pid: deadPid() });
    const stopped: { dir: string; cloneStillThere: boolean }[] = [];
    await acquire(
      manager(1, {
        removeSandboxes: (dir) => {
          stopped.push({ dir, cloneStillThere: existsSync(slot.dir) });
          return ["abc123"];
        },
      }),
      task(2),
    );
    expect(stopped).toEqual([{ dir: join(root, "0"), cloneStillThere: true }]);
    expect(gitOut(main.dir, ["show", "agent/T-1:done.ts"])).toBe("export {};");
    expect(logs.some((line) => /removed the sandbox.*abc123/.test(line))).toBe(
      true,
    );
  });

  it("does not log the integration branch the dead run was made from as an extra ref", async () => {
    const dead = { ...task(1), integration: "spec/s" };
    const slot = await acquire(manager(1), dead);
    git(slot.dir, ["branch", "spec/s"]);
    git(slot.dir, ["checkout", "--quiet", "-b", "agent/T-1"]);
    writeFileSync(join(slot.dir, "done.ts"), "export {};\n");
    git(slot.dir, ["add", "-A"]);
    git(slot.dir, [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@b",
      "commit",
      "--quiet",
      "-m",
      "agent work",
    ]);
    writeFileSync(
      join(root, "0", "lock"),
      JSON.stringify({ ...dead, pid: deadPid() }),
    );
    await acquire(manager(1), task(2));
    expect(gitOut(main.dir, ["show", "agent/T-1:done.ts"])).toBe("export {};");
    expect(logs.filter((line) => line.includes("extra ref"))).toEqual([]);
  });

  it("then saves uncommitted changes as a diff", async () => {
    await abandoned({ commit: true, dirty: true, pid: deadPid() });
    await acquire(manager(1), task(2));
    const files = readdirSync(salvageDir);
    expect(files).toEqual(["job-1-attempt-1.diff"]);
    expect(
      readFileSync(join(salvageDir, files[0] as string), "utf8"),
    ).toContain("unfinished.ts");
  });

  it("saves the changes sitting in a Sandcastle worktree inside the clone too", async () => {
    const slot = await abandoned({ pid: deadPid() });
    const worktree = join(slot.dir, ".sandcastle", "worktrees", "agent-T-1");
    mkdirSync(join(slot.dir, ".sandcastle", "worktrees"), { recursive: true });
    git(slot.dir, ["worktree", "add", "--quiet", "-b", "agent/T-1", worktree]);
    writeFileSync(join(worktree, "half.ts"), "const x = \n");
    await acquire(manager(1), task(2));
    expect(
      readFileSync(join(salvageDir, "job-1-attempt-1.diff"), "utf8"),
    ).toContain("half.ts");
  });

  it("then rebuilds the clone from scratch", async () => {
    await abandoned({ commit: true, dirty: true, pid: deadPid() });
    const next = await acquire(manager(1), task(2));
    expect(existsSync(join(next.dir, "unfinished.ts"))).toBe(false);
    expect(existsSync(join(next.dir, "done.ts"))).toBe(false);
    expect(gitOut(next.dir, ["status", "--porcelain"])).toBe("");
    expect(logs.some((line) => /zombie/.test(line))).toBe(true);
  });

  it("keeps going when the previous task's branch cannot be taken back", async () => {
    const slot = await abandoned({ pid: deadPid() }); // no agent branch was ever made
    expect(existsSync(slot.dir)).toBe(true);
    expect(await acquire(manager(1), task(2))).toBeDefined();
  });

  it("only one of two racing reclaimers wins the zombie slot", async () => {
    await abandoned({ pid: deadPid() });
    held.add("2:1");
    held.add("3:1");
    const results = await Promise.all([
      manager(1).acquire(task(2)),
      manager(1).acquire(task(3)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a lock file that is still being written is busy; a stale garbage one is a zombie", async () => {
    mkdirSync(join(root, "0"), { recursive: true });
    const lock = join(root, "0", "lock");
    writeFileSync(lock, '{"jobId": 1, "att');
    expect(await manager(1).acquire(task(2))).toBeUndefined(); // written a moment ago
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await acquire(manager(1), task(2))).toBeDefined();
  });

  it("assumes the lock is held when the API cannot be asked", async () => {
    await abandoned();
    const m = manager(1, {
      isHeld: async () => {
        throw new Error("API down");
      },
    });
    expect(await m.acquire(task(2))).toBeUndefined();
    expect(logs.some((line) => /could not ask/.test(line))).toBe(true);
  });

  it("keeps the clone when the commits cannot be taken back, so no work is lost", async () => {
    await abandoned({ commit: true, pid: deadPid() });
    // main already has a diverged agent/T-1, so the fetch is refused
    git(main.dir, ["branch", "agent/T-1", "HEAD"]);
    main.commit({ "other.txt": "x\n" }, "main moved");
    git(main.dir, ["checkout", "--quiet", "agent/T-1"]);
    main.commit({ "diverged.txt": "y\n" }, "diverged");
    git(main.dir, ["checkout", "--quiet", "main"]);
    await acquire(manager(1), task(2));
    const kept = readdirSync(salvageDir).filter((n) => n.startsWith("clone-"));
    expect(kept).toEqual(["clone-job-1-attempt-1"]);
    expect(existsSync(join(salvageDir, kept[0] as string, "done.ts"))).toBe(
      true,
    );
  });

  it("does not wedge on a torn last.json: it keeps what it finds and goes on", async () => {
    const slot = await abandoned({ pid: deadPid() });
    writeFileSync(join(root, "0", "last.json"), '{"jobId":');
    const next = await acquire(manager(1), task(2));
    expect(next).toBeDefined();
    expect(
      readdirSync(salvageDir).some((n) => n.startsWith("clone-0-backend")),
    ).toBe(true);
    expect(existsSync(slot.dir)).toBe(true); // the new clone is in the same place
  });

  it("a losing reclaimer never touches the winner's fresh clone", async () => {
    await abandoned({ commit: true, pid: deadPid() });
    held.add("2:1");
    held.add("3:1");
    const [one, two] = await Promise.all([
      manager(1).acquire(task(2)),
      manager(1).acquire(task(3)),
    ]);
    const winner = (one ?? two) as Slot;
    expect(existsSync(join(winner.dir, "src/a.ts"))).toBe(true);
    expect(gitOut(winner.dir, ["status", "--porcelain"])).toBe("");
  });
});

describe("taking the result back", () => {
  function slotWithBranches(branches: string[]) {
    const slot = join(mkdtempSync(join(tmpdir(), "afk-clone-")), "clone");
    git(tmpdir(), ["clone", "--quiet", "--no-hardlinks", main.dir, slot]);
    for (const branch of branches) {
      git(slot, ["checkout", "--quiet", "-b", branch]);
      writeFileSync(
        join(slot, `${branch.replaceAll("/", "-")}.txt`),
        `${branch}\n`,
      );
      git(slot, ["add", "-A"]);
      git(slot, [
        "-c",
        "user.name=A",
        "-c",
        "user.email=a@b",
        "commit",
        "--quiet",
        "-m",
        branch,
      ]);
    }
    return slot;
  }
  const has = (ref: string) =>
    git(main.dir, ["rev-parse", "--verify", "--quiet", ref]).code === 0;

  it("fetches the ticket's branch and only that", () => {
    const slotClone = slotWithBranches([
      "agent/T-1",
      "agent/T-2",
      "spec/s",
      "scratch",
    ]);
    const log: string[] = [];
    const result = retrieveResult({
      slotClone,
      mainClone: main.dir,
      ref: "agent/T-1",
      log: (l) => log.push(l),
    });
    expect(result.fetched).toBe(true);
    expect(has("agent/T-1")).toBe(true);
    for (const other of ["agent/T-2", "spec/s", "scratch"])
      expect(has(other)).toBe(false);
  });

  it("writes the other refs it found to the log instead of taking them", () => {
    const slotClone = slotWithBranches(["agent/T-1", "agent/T-2", "spec/s"]);
    const log: string[] = [];
    const result = retrieveResult({
      slotClone,
      mainClone: main.dir,
      ref: "agent/T-1",
      log: (l) => log.push(l),
    });
    expect(result.extraRefs.sort()).toEqual([
      "refs/heads/agent/T-2",
      "refs/heads/spec/s",
    ]);
    expect(log.join("\n")).toContain("refs/heads/agent/T-2");
    expect(log.join("\n")).toContain("refs/heads/spec/s");
  });

  it("does not call the integration branch the ticket was made from extra", () => {
    const slotClone = slotWithBranches(["agent/T-1", "spec/s", "agent/T-2"]);
    expect(
      retrieveResult({
        slotClone,
        mainClone: main.dir,
        ref: "agent/T-1",
        integration: "spec/s",
      }).extraRefs,
    ).toEqual(["refs/heads/agent/T-2"]);
  });

  it("also reports tags, and does not follow them along with the branch", () => {
    const slotClone = slotWithBranches(["agent/T-1"]);
    git(slotClone, ["tag", "v1", "HEAD"]);
    const result = retrieveResult({
      slotClone,
      mainClone: main.dir,
      ref: "agent/T-1",
    });
    expect(result.extraRefs).toEqual(["refs/tags/v1"]);
    expect(gitOut(main.dir, ["tag"])).toBe("");
  });

  it("takes back the ticket branch of a spec that carries its database's id, and knows its gate branch", () => {
    const slotClone = slotWithBranches([
      "agent/a1b2c3/T-1",
      "gate/T-1",
      "agent/a1b2c3/T-2",
    ]);
    const result = retrieveResult({
      slotClone,
      mainClone: main.dir,
      ref: "agent/a1b2c3/T-1",
    });
    expect(result.fetched).toBe(true);
    expect(result.extraRefs).toEqual(["refs/heads/agent/a1b2c3/T-2"]);
  });

  it("does not call this ticket's gate branch or the default branch extra", () => {
    const slotClone = slotWithBranches(["agent/T-1", "gate/T-1"]);
    expect(
      retrieveResult({ slotClone, mainClone: main.dir, ref: "agent/T-1" })
        .extraRefs,
    ).toEqual([]);
  });

  it("does not call master extra when that is the repo's default branch", () => {
    git(main.dir, ["branch", "-m", "main", "master"]);
    const slotClone = slotWithBranches(["agent/T-1", "gate/T-1"]);
    expect(
      retrieveResult({
        slotClone,
        mainClone: main.dir,
        ref: "agent/T-1",
        defaultBranch: "master",
      }).extraRefs,
    ).toEqual([]);
  });

  it("checks objects while fetching", () => {
    // a slot whose branch points at a commit with a broken tree reference must not get through
    const slotClone = slotWithBranches(["agent/T-1"]);
    const tip = gitOut(slotClone, ["rev-parse", "HEAD"]);
    const tree = gitOut(slotClone, ["rev-parse", "HEAD^{tree}"]);
    const objectPath = join(
      slotClone,
      ".git",
      "objects",
      tree.slice(0, 2),
      tree.slice(2),
    );
    // corrupt the tree object: fsck on receive rejects it, a plain fetch of a local path may not
    // (git writes objects read-only: only root can write over one, so remove it first)
    rmSync(objectPath);
    writeFileSync(objectPath, "garbage", { mode: 0o644 });
    const result = retrieveResult({
      slotClone,
      mainClone: main.dir,
      ref: "agent/T-1",
    });
    expect(result.fetched).toBe(false);
    expect(result.error).toBeDefined();
    expect(has("agent/T-1")).toBe(false);
    expect(tip).toHaveLength(40);
  });

  it("is not fetched when the branch does not exist in the slot", () => {
    const slotClone = slotWithBranches([]);
    expect(
      retrieveResult({ slotClone, mainClone: main.dir, ref: "agent/T-1" }),
    ).toEqual({
      fetched: false,
      extraRefs: [],
    });
  });

  it("will not fetch a ref that is not a ticket branch", () => {
    const slotClone = slotWithBranches([]);
    expect(() =>
      retrieveResult({ slotClone, mainClone: main.dir, ref: "main" }),
    ).toThrow(/not a ticket branch/);
    expect(() =>
      retrieveResult({
        slotClone,
        mainClone: main.dir,
        ref: "refs/heads/agent/T-1:refs/heads/main",
      }),
    ).toThrow();
  });
});

describe("processAlive", () => {
  it("knows this process and a dead one", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(deadPid())).toBe(false);
  });
});
