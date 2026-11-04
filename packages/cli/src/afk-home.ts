import { homedir } from "node:os";
import { join } from "node:path";

// The planning machine's AFK home, as the worker has it: $AFK_HOME, else ~/.afk.
export function afkHome(env: Record<string, string | undefined>): string {
  return env.AFK_HOME || join(env.HOME ?? homedir(), ".afk");
}
