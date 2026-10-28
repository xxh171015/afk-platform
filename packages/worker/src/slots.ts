import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git, gitOrThrow } from "@afk/pipeline";

// Slots: every task gets its own throwaway clone of the repo, so whatever an agent breaks, it breaks in its own
// copy (docs/design.md「Git 操作规范」). The number of slots is the worker's concurrency limit.
//
//   <root>/<n>/lock          O_EXCL lock file: {jobId, attempt, pid, repo, ref}
//   <root>/<n>/<repo>/       the clone (git clone --no-hardlinks of the main clone)
//   <root>/<n>/last.json     what the clone last belonged to, kept while a failed task's clone is kept

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
  salvageDir: string; // where the diffs of uncommitted work are saved
  // Does the API still consider (job, attempt) the live holder? A lock whose job lost its lease is a zombie.
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

const TICKET_REF = /^agent\/T-[1-9][0-9]*$/;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"; // exists, just not ours
  }
}

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

  // A free slot with a fresh clone, or undefined when every slot is busy.
  async acquire(task: SlotTask): Promise<Slot | undefined> {
    if (!TICKET_REF.test(task.ref))
      throw new RangeError(`not a ticket branch: ${task.ref}`);
    for (let index = 0; index < this.options.count; index++) {
      const dir = this.slotDir(index);
      mkdirSync(dir, { recursive: true });
      if (!(await this.takeLock(index, task))) continue;
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

  private lockPath(index: number) {
    return join(this.slotDir(index), "lock");
  }

  private readLock(index: number): SlotLock | undefined {
    try {
      return JSON.parse(readFileSync(this.lockPath(index), "utf8")) as SlotLock;
    } catch {
      return undefined; // missing, or half-written by a process that died mid-write
    }
  }

  // O_EXCL: whoever creates the file owns the slot. A lock that is there is only taken over when it is a zombie.
  private async takeLock(index: number, task: SlotTask): Promise<boolean> {
    const path = this.lockPath(index);
    const lock: SlotLock = { ...task, pid: process.pid };
    for (let tries = 0; tries < 2; tries++) {
      try {
        const fd = openSync(path, "wx");
        try {
          writeFileSync(fd, JSON.stringify(lock));
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
      const holder = this.readLock(index);
      if (holder && (await this.isLive(holder))) return false;
      this.log(
        `slot ${index}: lock of job ${holder?.jobId} attempt ${holder?.attempt} is a zombie`,
      );
      // Salvage first, then remove the lock; only if it is still the one we judged, so two reclaimers do not
      // both think they won.
      if (holder) this.salvage(index, holder);
      const now = this.readLock(index);
      if (JSON.stringify(now) !== JSON.stringify(holder)) return false;
      rmSync(path, { force: true });
    }
    return false;
  }

  private async isLive(lock: SlotLock): Promise<boolean> {
    const alive = (this.options.isProcessAlive ?? processAlive)(lock.pid);
    return alive && (await this.options.isHeld(lock.jobId, lock.attempt));
  }

  // Everything that belonged to an earlier task is dealt with before the slot is cloned again.
  private rebuild(index: number, task: SlotTask) {
    const dir = this.slotDir(index);
    const lastPath = join(dir, "last.json");
    if (existsSync(lastPath)) {
      this.salvage(
        index,
        JSON.parse(readFileSync(lastPath, "utf8")) as SlotTask,
      );
    }
    // anything else left in the slot (another repo's clone) is gone too
    for (const name of readdirSync(dir)) {
      if (name !== "lock" && name !== "last.json")
        rmSync(join(dir, name), { recursive: true, force: true });
    }
    const main = this.options.mainCloneFor(task.repo);
    gitOrThrow(dir, [
      "clone",
      "--quiet",
      "--no-hardlinks",
      main,
      join(dir, task.repo),
    ]);
    writeFileSync(lastPath, JSON.stringify(task));
  }

  // 1 take back the commits the task made, 2 save uncommitted changes as a diff, 3 delete the clone.
  private salvage(index: number, previous: SlotTask) {
    const dir = this.slotDir(index);
    const clone = join(dir, previous.repo);
    if (existsSync(clone)) {
      const taken = retrieveResult({
        slotClone: clone,
        mainClone: this.options.mainCloneFor(previous.repo),
        ref: previous.ref,
        log: (line) => this.log(`slot ${index}: ${line}`),
      });
      if (taken.error)
        this.log(
          `slot ${index}: could not take back ${previous.ref}: ${taken.error}`,
        );
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

export interface RetrieveResult {
  fetched: boolean;
  extraRefs: string[]; // refs the slot has besides the ticket's branch: logged, never taken back
  error?: string;
}

// Takes the ticket's branch from a slot into the main clone: that one ref, with object checking on, because
// the slot's content came out of a sandbox. Whatever else the slot holds stays there.
export function retrieveResult(input: {
  slotClone: string;
  mainClone: string;
  ref: string;
  log?: (line: string) => void;
}): RetrieveResult {
  if (!TICKET_REF.test(input.ref))
    throw new RangeError(`not a ticket branch: ${input.ref}`);
  const refs = git(input.slotClone, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
  ])
    .stdout.split("\n")
    .filter(Boolean);
  const wanted = `refs/heads/${input.ref}`;
  const extraRefs = refs.filter(
    (ref) => ref !== wanted && ref !== "refs/heads/main",
  );
  for (const ref of extraRefs)
    input.log?.(`extra ref in the slot, not taken back: ${ref}`);
  if (!refs.includes(wanted)) return { fetched: false, extraRefs };
  const fetch = git(input.mainClone, [
    "-c",
    "transfer.fsckObjects=true",
    "fetch",
    "--quiet",
    input.slotClone,
    `${wanted}:${wanted}`,
  ]);
  return fetch.code === 0
    ? { fetched: true, extraRefs }
    : { fetched: false, extraRefs, error: fetch.out.slice(0, 400) };
}

// `git diff HEAD` plus the names of untracked files, for the clone and for every worktree Sandcastle left in it.
function uncommittedChanges(clone: string): string | undefined {
  const places = [clone];
  const worktrees = join(clone, ".sandcastle", "worktrees");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees))
      places.push(join(worktrees, name));
  }
  const parts: string[] = [];
  for (const place of places) {
    const status = git(place, ["status", "--porcelain"]).stdout.trim();
    if (!status) continue;
    parts.push(
      `# ${place}\n${git(place, ["diff", "HEAD"]).stdout}\n--- status ---\n${status}\n`,
    );
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
