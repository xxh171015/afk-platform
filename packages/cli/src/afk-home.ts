import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The planning machine's AFK home, as the worker has it: $AFK_HOME, else ~/.afk.
export function afkHome(env: Record<string, string | undefined>): string {
  return env.AFK_HOME || join(env.HOME ?? homedir(), ".afk");
}

// What plat remembers on this machine: the platform's address the person confirmed with `plat connect`.
interface PlatConfig {
  apiUrl?: string;
}

const configFile = (home: string) => join(home, "plat.json");

function readConfig(home: string): PlatConfig {
  try {
    return JSON.parse(readFileSync(configFile(home), "utf8"));
  } catch {
    return {};
  }
}

export function rememberedApiUrl(home: string): string | undefined {
  const url = readConfig(home).apiUrl;
  return typeof url === "string" && url ? url : undefined;
}

export function rememberApiUrl(home: string, apiUrl: string): string {
  mkdirSync(home, { recursive: true });
  const file = configFile(home);
  writeFileSync(
    file,
    `${JSON.stringify({ ...readConfig(home), apiUrl }, null, 2)}\n`,
  );
  return file;
}
