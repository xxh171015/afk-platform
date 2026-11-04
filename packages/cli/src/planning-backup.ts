import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The planning docs a spec's confirm took out of the checkout, kept outside it on the planning machine, in the
// spec's folder under ~/.afk/planning/ (where to-tickets writes the ticket files): retry-planning puts them back
// from here, waive-planning drops them, and the folder goes once the spec is merged or cancelled.

export interface PlanningBackup {
  apiUrl: string; // the platform the spec is on: spec ids are per platform
  repo: string;
  files: string[];
  patch: string;
}

const PATCH = "planning-docs.patch";
const META = "planning-docs.json";

// The planning machine's AFK home, as the worker has it: $AFK_HOME, else ~/.afk.
export function afkHome(env: Record<string, string | undefined>): string {
  return env.AFK_HOME || join(env.HOME ?? homedir(), ".afk");
}

export const specPlanningDir = (home: string, spec: string) =>
  join(home, "planning", spec);

export function saveBackup(
  home: string,
  spec: string,
  backup: PlanningBackup,
): string {
  const dir = specPlanningDir(home, spec);
  mkdirSync(dir, { recursive: true });
  const { patch, ...meta } = backup;
  writeFileSync(join(dir, PATCH), patch);
  writeFileSync(join(dir, META), `${JSON.stringify(meta, null, 2)}\n`);
  return join(dir, PATCH);
}

export function readBackup(
  home: string,
  spec: string,
): PlanningBackup | undefined {
  const dir = specPlanningDir(home, spec);
  try {
    const meta = JSON.parse(readFileSync(join(dir, META), "utf8"));
    return { ...meta, patch: readFileSync(join(dir, PATCH), "utf8") };
  } catch {
    return undefined;
  }
}

// The backup goes; the spec's folder too when nothing else is in it.
export function dropBackup(home: string, spec: string): void {
  const dir = specPlanningDir(home, spec);
  for (const file of [PATCH, META]) rmSync(join(dir, file), { force: true });
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

const FINISHED = ["merged", "cancelled"];

// The folders of this platform's specs that are merged or cancelled, removed. `stateOf` gives a spec's state, or
// undefined when it cannot be told; such a folder stays.
export async function dropFinishedSpecs(
  home: string,
  apiUrl: string,
  stateOf: (spec: string) => Promise<string | undefined>,
): Promise<string[]> {
  const root = join(home, "planning");
  if (!existsSync(root)) return [];
  const dropped: string[] = [];
  for (const spec of readdirSync(root)) {
    if (!/^S-[1-9][0-9]*$/.test(spec)) continue;
    if (readBackup(home, spec)?.apiUrl !== apiUrl) continue;
    const state = await stateOf(spec);
    if (state && FINISHED.includes(state)) {
      rmSync(specPlanningDir(home, spec), { recursive: true, force: true });
      dropped.push(spec);
    }
  }
  return dropped;
}
