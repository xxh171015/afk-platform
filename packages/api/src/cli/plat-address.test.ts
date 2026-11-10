import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@afk/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { listen, type RunningApi, testApp } from "../test/fake-worker.ts";

// plat remembers the platform's address the person confirmed, on the planning machine, so that a platform not on
// this machine needs no shell setting; --api-url and $AFK_API_URL still come first.

let db: TestDatabase;
let api: RunningApi;
let home: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrate(db.pool);
  api = await listen(testApp({ pool: db.pool, logDir: tmpdir() }));
  home = mkdtempSync(join(tmpdir(), "afk-home-"));
});
afterEach(async () => {
  await api.close();
  await db.drop();
  rmSync(home, { recursive: true, force: true });
});

// nothing listens here
const NOWHERE = "http://127.0.0.1:9";

async function plat(args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { AFK_HOME: home, ...env },
    readFile: async () => "",
    readDirectory: async () => [],
  });
  return { code, stdout, stderr };
}

describe("the platform's address", () => {
  it("is remembered by plat connect once the platform answers there, and used from then on", async () => {
    const connected = await plat(["connect", api.url]);

    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain(api.url);
    const blocked = await plat(["blocked"]);
    expect(blocked.code).toBe(0);
    expect(blocked.stdout).toContain("nothing");
  });

  it("is not remembered when nothing answers there", async () => {
    await plat(["connect", api.url]);

    const connected = await plat(["connect", NOWHERE]);

    expect(connected.code).toBe(1);
    expect(connected.stderr).toContain(NOWHERE);
    expect((await plat(["blocked"])).code).toBe(0);
  });

  it("gives way to $AFK_API_URL and --api-url", async () => {
    await plat(["connect", api.url]);

    expect((await plat(["blocked"], { AFK_API_URL: NOWHERE })).code).toBe(1);
    expect((await plat(["--api-url", NOWHERE, "blocked"])).code).toBe(1);
    expect(
      (await plat(["--api-url", api.url, "blocked"], { AFK_API_URL: NOWHERE }))
        .code,
    ).toBe(0);
  });

  it("is what plat connect without an address prints, and an empty $AFK_API_URL does not hide it", async () => {
    await plat(["connect", `${api.url}/`]);

    const shown = await plat(["connect"], { AFK_API_URL: "" });

    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(`the platform is at ${api.url} (`);
    const elsewhere = await plat(["connect"], { AFK_API_URL: NOWHERE });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toContain(`plat uses ${NOWHERE}`);
  });
});
