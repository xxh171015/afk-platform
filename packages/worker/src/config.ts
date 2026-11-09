import { hostname } from "node:os";
import { join } from "node:path";

// What `pnpm worker` needs to know, from the environment. Everything that is wrong is reported at once, in one
// sentence each, before anything starts.

export interface WorkerConfig {
  apiUrl: string;
  home: string; // slots, main clones, salvage and logs live under it
  workerId: string;
  slots: number;
  image: string; // one image for every project, so the worker does not pick per repo (override with AFK_SANDBOX_IMAGE)
  model: string;
  cursorApiKey: string;
  credentialsDir: string; // the GitHub App's key and ids
  gitlabDir: string; // one file per GitLab host, named after it, holding a PAT
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface ConfigSources {
  env: Record<string, string | undefined>;
  homedir: string;
  // The text of a file, or undefined when it does not exist.
  readFile(path: string): string | undefined;
}

// KEY=VALUE lines of ~/.afk/env; comments, blank lines, `export ` and one pair of quotes around a value are allowed.
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

const positiveInt = (
  text: string | undefined,
  fallback: number,
  max: number,
) => {
  if (text === undefined || text === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
};

export function loadConfig(sources: ConfigSources): WorkerConfig {
  const { env } = sources;
  const problems: string[] = [];
  const home = env.AFK_HOME || join(sources.homedir, ".afk");
  const fileText = sources.readFile(join(home, "env"));
  // The environment wins over the file. Only the Cursor key is read from it: GitHub access goes through the App.
  const cursorApiKey =
    env.CURSOR_API_KEY || parseEnvFile(fileText ?? "").CURSOR_API_KEY || "";
  if (!cursorApiKey)
    problems.push(
      `CURSOR_API_KEY is not set: export it, or put CURSOR_API_KEY=... in ${join(home, "env")}`,
    );

  const model = env.AFK_MODEL ?? "";
  if (!model)
    problems.push("AFK_MODEL is not set: the Cursor model the agents use");

  const slots = positiveInt(env.AFK_SLOTS, 2, 16);
  if (slots === undefined)
    problems.push(
      `AFK_SLOTS must be a whole number from 1 to 16, got ${JSON.stringify(env.AFK_SLOTS)}`,
    );

  const apiUrl = env.AFK_API_URL || "http://127.0.0.1:3000";
  try {
    new URL(apiUrl);
  } catch {
    problems.push(`AFK_API_URL is not an address: ${JSON.stringify(apiUrl)}`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    apiUrl,
    home,
    workerId: env.AFK_WORKER_ID || hostname(),
    slots: slots as number,
    image: env.AFK_SANDBOX_IMAGE || "sandcastle:afk-platform",
    model,
    cursorApiKey,
    // fixed under ~/.afk/secrets by design (not under AFK_HOME): secrets do not move with the working folders
    credentialsDir:
      env.AFK_GITHUB_APP_DIR ||
      join(sources.homedir, ".afk", "secrets", "github-app"),
    gitlabDir:
      env.AFK_GITLAB_DIR || join(sources.homedir, ".afk", "secrets", "gitlab"),
  };
}
