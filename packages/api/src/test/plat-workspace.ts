import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Io, run } from "@afk/cli";
import { gitOrThrow } from "@afk/pipeline";
import { makeRepo, type TestRepo } from "@afk/pipeline/testing";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "../db/test-db.ts";
import {
  listen,
  type RunningApi,
  teardownTestRuntime,
  testApp,
} from "./fake-worker.ts";

// The real HTTP API and a real Postgres, with `plat` run in real git checkouts whose origin is a GitHub address
// that git rewrites (url.<bare>.insteadOf) to a local bare repo, so pushes and ls-remote work offline.

export interface Checkout {
  dir: string;
  origin: TestRepo; // the repo the address leads to
}

export interface PlatResult {
  code: number;
  stdout: string;
  stderr: string;
  questions: string[];
}

export interface PlatWorkspace {
  api: RunningApi;
  db: TestDatabase;
  afkHome: string; // the planning machine's AFK home ($AFK_HOME) plat is run with
  // A checkout at <root>/<folder> whose origin is `address`. The remote's default branch is `defaultBranch`; with
  // `reachable: false` the address leads nowhere, as when there is no network or no credentials.
  checkout(
    folder: string,
    address: string,
    files?: Record<string, string>,
    options?: { defaultBranch?: string; reachable?: boolean },
  ): Checkout;
  // `answer` is what the person says when asked; "nobody" means nobody can be asked (no terminal).
  // `io` replaces parts of what plat is run with; its env is added to plat's.
  plat(
    cwd: string,
    args: string[],
    answer?: boolean | "nobody",
    io?: Partial<Io>,
  ): Promise<PlatResult>;
  close(): Promise<void>;
}

export async function platWorkspace(): Promise<PlatWorkspace> {
  const db = await createMigratedTestDatabase();
  const logDir = await mkdtemp(join(tmpdir(), "afk-logs-"));
  const api = await listen(testApp({ pool: db.pool, logDir }));
  // the hosts a worker with a GitHub App and a gitlab.com PAT reports at start
  await fetch(`${api.url}/worker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: "w1",
      hosts: [
        { host: "github.com", kind: "github" },
        { host: "gitlab.com", kind: "gitlab" },
      ],
    }),
  });
  // git --show-toplevel is the real path; on macOS tmpdir() is /var → /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-work-")));
  const afkHome = join(root, ".afk");
  const cleanups: (() => void)[] = [];

  return {
    api,
    db,
    afkHome,
    checkout(
      folder,
      address,
      files = { "README.md": "r\n" },
      { defaultBranch = "main", reachable = true } = {},
    ) {
      const origin = makeRepo(files);
      cleanups.push(() => origin.cleanup());
      if (defaultBranch !== "main") {
        gitOrThrow(origin.dir, ["branch", "-m", "main", defaultBranch]);
      }
      // a remote people push to is not checked out anywhere
      gitOrThrow(origin.dir, ["config", "receive.denyCurrentBranch", "ignore"]);
      const dir = join(root, folder);
      gitOrThrow(root, ["clone", "--quiet", origin.dir, dir]);
      gitOrThrow(dir, ["config", "user.name", "Person"]);
      gitOrThrow(dir, ["config", "user.email", "person@example.com"]);
      gitOrThrow(dir, ["remote", "set-url", "origin", address]);
      const target = reachable ? origin.dir : join(root, "nowhere");
      gitOrThrow(dir, ["config", `url.${target}.insteadOf`, address]);
      return { dir, origin };
    },
    async plat(cwd, args, answer, extra = {}) {
      let stdout = "";
      let stderr = "";
      const questions: string[] = [];
      const io: Io = {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        // plat init does not wait for a worker to check the GitHub App
        env: {
          AFK_API_URL: api.url,
          AFK_HOME: afkHome,
          AFK_ACCESS_WAIT_SECONDS: "0",
          AFK_POLL_SECONDS: "0.05",
          ...extra.env,
        },
        readFile: async (path) =>
          readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf8"),
        readDirectory: async (path) =>
          readdirSync(join(cwd, path), { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => ({
              name: e.name,
              text: readFileSync(join(cwd, path, e.name), "utf8"),
            })),
        cwd,
        confirm:
          answer === "nobody"
            ? undefined
            : async (question) => {
                questions.push(question);
                if (answer === undefined) {
                  throw new Error("plat asked unexpectedly");
                }
                return answer;
              },
      };
      const { env: _env, ...rest } = extra;
      const code = await run(args, { ...io, ...rest });
      return { code, stdout, stderr, questions };
    },
    async close() {
      await teardownTestRuntime({ api, db });
      for (const cleanup of cleanups.splice(0)) cleanup();
      await rm(root, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    },
  };
}
