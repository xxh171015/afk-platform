import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { PLAT_DEV } from "@afk/shared";

// A planning machine follows the platform by itself: plat compares its own file with the one the platform hands out
// (GET /version's platFingerprint) before a command, and the API refuses to publish from an older one (409
// plat-outdated). Either way plat replaces itself with the platform's and runs the same command again; the new plat
// then brings the skills and the planning files up (`plat sync`) and says in one line what changed.

// Set when the platform's bundle is built (packages/api/src/cli/cli-bundle.ts): only that file is replaced, never a
// plat run from a checkout of the platform.
declare const __AFK_PLAT_BUNDLED__: boolean | undefined;
const BUNDLED = typeof __AFK_PLAT_BUNDLED__ !== "undefined";

// The environment variable the new plat is run with: the version it replaced. It also stops a second replacement.
export const UPDATED_FROM = "AFK_PLAT_UPDATED_FROM";

/** The plat file this process runs from, which may be replaced; "" when it is not the platform's bundle. */
export function platFile(platPath: string | undefined): string {
  if (platPath !== undefined) return platPath;
  const script = process.argv[1];
  if (!BUNDLED || !script) return "";
  try {
    return realpathSync(script);
  } catch {
    return "";
  }
}

/** What plat sends as PLAT_HEADER: the sha256 of its file, or PLAT_DEV when it is not the platform's bundle. */
export function fingerprintOf(file: string): string {
  if (!file) return PLAT_DEV;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return PLAT_DEV;
  }
}

/** Thrown when the platform hands out a newer plat than this one. */
export class PlatOutdated extends Error {
  constructor() {
    super("this plat is older than the one the platform hands out");
  }
}

/** Writes the platform's plat over `file`; false when it was the same already. Throws when it cannot download. */
export async function replacePlat(
  file: string,
  base: string,
): Promise<boolean> {
  const response = await fetch(`${base}/cli/plat.mjs`).catch(() => null);
  if (!response?.ok)
    throw new Error(
      `could not download plat from ${base}/cli/plat.mjs (${response ? `HTTP ${response.status}` : "the platform does not answer"})`,
    );
  const text = await response.text();
  if (text === readFileSync(file, "utf8")) return false;
  const next = `${file}.next`;
  writeFileSync(next, text, { mode: 0o755 });
  renameSync(next, file);
  return true;
}

// Runs plat again, from `file`, with `args` and `env` added to this process's; its exit code.
export type Rerun = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => number;

export const rerunPlat: Rerun = (file, args, env) =>
  spawnSync(process.execPath, [file, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  }).status ?? 1;
