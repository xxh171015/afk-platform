import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git, gitOrThrow } from "@afk/pipeline";

// Slots: every task gets its own throwaway clone of the repo, so whatever an agent breaks, it breaks in its own
// copy (docs/design.md「Git 操作规范」). The number of slots is the worker's concurrency limit (GLOSSARY: Slot).
//
//   <root>/<n>/lock          O_EXCL lock file: {jobId, attempt, pid, repo, ref}
//   <root>/<n>/<repo>/       the clone (git clone --no-hardlinks of the main clone)
//   <root>/<n>/last.json     what the clone belongs to; deleted with the clone after a success

export interface SlotTask {
  jobId: number;
  attempt: number;
  repo: string; // directory name of the repo, e.g. "backend"
  ref: string; // the ticket's branch, agent/T-123: the only ref that is ever taken back
}

export interface SlotLock extends SlotTask {
  pid: number;
}

export interface SlotManagerOptions {
  root: string;
  count: number;
  mainCloneFor(repo: string): string;
  salvageDir: string; // where diffs of uncommitted work, and clones that could not be emptied, are kept
  // Does the API still consider (job, attempt) the live holder? A lock whose job lost its lease is a zombie.
  // If the API cannot be asked, the lock is assumed to be held: never destroy work on a guess.
  isHeld(jobId: number, attempt: number): Promise<boolean>;
  isProcessAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

export interface Slot {
  index: number;
  dir: string; // the clone
  task: SlotTask;
  // On success the clone is deleted; on failure it stays until the slot is used again, then it is rebuilt.
  release(outcome: "success" | "failure"): Promise<void>;
}

// A ticket's branch, or the one the overall fix of a spec is made on.
const TICKET_REF = /^agent\/(T-[1-9][0-9]*|S-[1-9][0-9]*-final)$/;
// A lock file another process is still writing is not a zombie; give it a moment.
const LOCK_WRITE_GRACE_MS = 5_000;

const errnoCode = (error: unknown) => (error as { code?: string }).code;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM"; // exists, just not ours
  }
}

// The clone is writable from inside the sandbox, so its own .git/config is not to be trusted: no filesystem
// monitor, no hooks and no external diff or text conversion programs may run on the host because of it.
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const safeGit = (clone: string, args: string[]) =>
  git(clone, [...SAFE, ...args]);

export class SlotManager {
  private readonly options: SlotManagerOptions;

  constructor(options: SlotManagerOptions) {
    this.options = options;
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private slotDir(index: number) {
    return join(this.options.root, String(index));
  }

  private lockPath(index: number) {
    return join(this.slotDir(index), "lock");
  }

  // A free slot with a fresh clone, or undefined when every slot is busy.
  async acquire(task: SlotTask): Promise<Slot | undefined> {
    if (!TICKET_REF.test(task.ref))
      throw new RangeError(`not a ticket branch: ${task.ref}`);
    for (let index = 0; index < this.options.count; index++) {
      mkdirSync(this.slotDir(index), { recursive: true });
      if (!(await this.takeLock(index, task))) continue;
      // From here the slot is ours: only now is anything left over from earlier touched.
      try {
        this.rebuild(index, task);
      } catch (error) {
        this.dropLock(index, task);
        throw error;
      }
      return this.slotFor(index, task);
    }
    return undefined;
  }

  private readLock(index: number): SlotLock | undefined {
    try {
      return JSON.parse(readFileSync(this.lockPath(index), "utf8")) as SlotLock;
    } catch {
      return undefined; // missing, or not (yet) valid JSON
    }
  }

  // O_EXCL: whoever creates the file owns the slot. A lock that is there is only taken over when it is a zombie.
  // Takeovers go one at a time through a second O_EXCL file, and the zombie is judged again under it, so a slow
  // reclaimer cannot remove the live lock a faster one has just made.
  private async takeLock(index: number, task: SlotTask): Promise<boolean> {
    if (this.createLock(index, task)) return true;
    if (await this.holderIsLive(index)) return false;
    const gate = `${this.lockPath(index)}.reclaim`;
    if (!this.createFile(gate, String(process.pid))) {
      // another reclaimer is at it; a gate left behind by a crashed one eventually goes away
      if (fileAge(gate) > LOCK_WRITE_GRACE_MS * 6)
        rmSync(gate, { force: true });
      return false;
    }
    try {
      if (await this.holderIsLive(index)) return false;
      this.log(`slot ${index}: the lock is a zombie`);
      rmSync(this.lockPath(index), { force: true });
      return this.createLock(index, task);
    } finally {
      rmSync(gate, { force: true });
    }
  }

  private createLock(index: number, task: SlotTask): boolean {
    const lock: SlotLock = { ...task, pid: process.pid };
    return this.createFile(this.lockPath(index), JSON.stringify(lock));
  }

  private createFile(path: string, content: string): boolean {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return false;
      throw error;
    }
  }

  private async holderIsLive(index: number): Promise<boolean> {
    const holder = this.readLock(index);
    if (!holder) {
      // no valid lock content: a writer in the middle of its write, or garbage left by a crash
      try {
        return (
          Date.now() - statSync(this.lockPath(index)).mtimeMs <
          LOCK_WRITE_GRACE_MS
        );
      } catch {
        return false; // gone already
      }
    }
    if (!(this.options.isProcessAlive ?? processAlive)(holder.pid))
      return false;
    try {
      return await this.options.isHeld(holder.jobId, holder.attempt);
    } catch (error) {
      this.log(
        `slot ${index}: could not ask whether job ${holder.jobId} is still held: ${String(error)}`,
      );
      return true;
    }
  }

  // Everything that belonged to an earlier task is dealt with before the slot is cloned again.
  private rebuild(index: number, task: SlotTask) {
    const dir = this.slotDir(index);
    const lastPath = join(dir, "last.json");
    if (existsSync(lastPath)) this.salvage(index, readLast(lastPath));
    // anything else left in the slot (another repo's clone) is gone too
    for (const name of readdirSync(dir)) {
      if (name !== "lock" && name !== "last.json")
        rmSync(join(dir, name), { recursive: true, force: true });
    }
    // Written before the clone, so a crash at any later point leaves what recovery needs to find the work.
    const tmp = `${lastPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(task));
    renameSync(tmp, lastPath);
    const main = this.options.mainCloneFor(task.repo);
    gitOrThrow(dir, [
      "clone",
      "--quiet",
      "--no-hardlinks",
      main,
      join(dir, task.repo),
    ]);
  }

  // 1 take back the commits the task made, 2 save uncommitted changes as a diff, 3 delete the clone. If the
  // commits could not be taken back, the clone is moved out of the way instead of deleted.
  private salvage(index: number, previous: SlotTask | undefined) {
    const dir = this.slotDir(index);
    const keep = (why: string, clone: string, label: string) => {
      mkdirSync(this.options.salvageDir, { recursive: true });
      const target = join(this.options.salvageDir, `clone-${label}`);
      rmSync(target, { recursive: true, force: true });
      renameSync(clone, target);
      this.log(`slot ${index}: ${why}; the clone was kept at ${target}`);
    };
    if (!previous) {
      // last.json is torn or unreadable: we cannot tell whose work this is, so nothing is deleted
      for (const name of readdirSync(dir)) {
        if (name !== "lock" && name !== "last.json")
          keep(
            "unknown owner",
            join(dir, name),
            `${index}-${name}-${Date.now()}`,
          );
      }
      rmSync(join(dir, "last.json"), { force: true });
      return;
    }
    const clone = join(dir, previous.repo);
    if (existsSync(clone)) {
      const taken = retrieveResult({
        slotClone: clone,
        mainClone: this.options.mainCloneFor(previous.repo),
        ref: previous.ref,
        log: (line) => this.log(`slot ${index}: ${line}`),
      });
      const diff = uncommittedChanges(clone);
      if (diff) {
        mkdirSync(this.options.salvageDir, { recursive: true });
        const file = join(
          this.options.salvageDir,
          `job-${previous.jobId}-attempt-${previous.attempt}.diff`,
        );
        writeFileSync(file, diff);
        this.log(`slot ${index}: saved uncommitted changes to ${file}`);
      }
      if (taken.error) {
        keep(
          `could not take back ${previous.ref} (${taken.error})`,
          clone,
          `job-${previous.jobId}-attempt-${previous.attempt}`,
        );
      }
    }
    rmSync(join(dir, previous.repo), { recursive: true, force: true });
    rmSync(join(dir, "last.json"), { force: true });
  }

  private dropLock(index: number, task: SlotTask) {
    const lock = this.readLock(index);
    if (
      lock &&
      lock.jobId === task.jobId &&
      lock.attempt === task.attempt &&
      lock.pid === process.pid
    ) {
      rmSync(this.lockPath(index), { force: true });
    }
  }

  private slotFor(index: number, task: SlotTask): Slot {
    const dir = this.slotDir(index);
    return {
      index,
      dir: join(dir, task.repo),
      task,
      release: async (outcome) => {
        if (outcome === "success") {
          rmSync(join(dir, task.repo), { recursive: true, force: true });
          rmSync(join(dir, "last.json"), { force: true });
        }
        this.dropLock(index, task);
      },
    };
  }
}

// How long ago a file was last written; infinitely long for a file that is not there.
function fileAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readLast(path: string): SlotTask | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SlotTask;
  } catch {
    return undefined;
  }
}

export interface RetrieveResult {
  fetched: boolean;
  extraRefs: string[]; // refs the slot has besides the ticket's own: logged, never taken back
  error?: string;
}

// Takes the ticket's branch from a slot into the main clone: that one ref, no tags, with object checking on,
// because the slot's content came out of a sandbox. Whatever else the slot holds stays there.
export function retrieveResult(input: {
  slotClone: string;
  mainClone: string;
  ref: string;
  log?: (line: string) => void;
}): RetrieveResult {
  const match = TICKET_REF.exec(input.ref);
  if (!match) throw new RangeError(`not a ticket branch: ${input.ref}`);
  const wanted = `refs/heads/${input.ref}`;
  // the platform's own local branches for this ticket are expected; the default branch and remotes are plumbing
  const expected = new Set([
    wanted,
    `refs/heads/gate/${match[1]}`,
    "refs/heads/main",
  ]);
  const refs = safeGit(input.slotClone, ["for-each-ref", "--format=%(refname)"])
    .stdout.split("\n")
    .filter((ref) => ref && !ref.startsWith("refs/remotes/"));
  const extraRefs = refs.filter((ref) => !expected.has(ref));
  for (const ref of extraRefs)
    input.log?.(`extra ref in the slot, not taken back: ${ref}`);
  if (!refs.includes(wanted)) return { fetched: false, extraRefs };
  const fetch = git(input.mainClone, [
    "-c",
    "transfer.fsckObjects=true",
    "fetch",
    "--quiet",
    "--no-tags",
    input.slotClone,
    `${wanted}:${wanted}`,
  ]);
  return fetch.code === 0
    ? { fetched: true, extraRefs }
    : {
        fetched: false,
        extraRefs,
        error:
          fetch.out.trim().slice(0, 400) || `git fetch exited ${fetch.code}`,
      };
}

// What was not committed, as a diff that can be applied again: tracked changes and the content of new files
// (made visible with intent-to-add; the clone is thrown away afterwards), for the clone and every worktree
// Sandcastle left inside it. Nothing here runs programs configured by the clone.
function uncommittedChanges(clone: string): string | undefined {
  const places = [clone];
  const worktrees = join(clone, ".sandcastle", "worktrees");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees))
      places.push(join(worktrees, name));
  }
  const parts: string[] = [];
  for (const place of places) {
    if (!safeGit(place, ["status", "--porcelain"]).stdout.trim()) continue;
    safeGit(place, ["add", "--intent-to-add", "--all"]);
    const diff = safeGit(place, [
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ]).stdout;
    parts.push(`# ${place}\n${diff}`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
