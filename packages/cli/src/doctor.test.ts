import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_VERSION } from "@afk/shared/platform-version";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "./index.ts";

let server: Server;
let url: string;
let puts: unknown[] = [];
let dir: string;
let home: string;

beforeEach(async () => {
  puts = [];
  dir = mkdtempSync(join(tmpdir(), "afk-doctor-"));
  home = mkdtempSync(join(tmpdir(), "afk-doctor-home-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
  writeFileSync(join(dir, "README.md"), "x\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: dir },
  );
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/version") {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          platformVersion: PLATFORM_VERSION,
          skillsSha: "x",
          platformCommit: "abc",
        }),
      );
      return;
    }
    if (req.method === "PUT" && req.url?.endsWith("/doctor-report")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as unknown;
        puts.push(parsed);
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ...(parsed as object),
            checkedAt: "2026-11-11T05:00:00.000Z",
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { HOME: home },
    cwd: dir,
    readFile: async (path: string) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
    readDirectory: async () => [],
  };
}

describe("plat doctor", () => {
  it("names why skills, the tracker doc, and AGENTS.md are missing, and the command that fixes each", async () => {
    const machine = io();
    const code = await run(["--api-url", url, "doctor"], machine);
    expect(code).toBe(0);
    const text = machine.out.join("");
    expect(text).toMatch(/skills\s+fail\s+.*to-spec skill was not found/s);
    expect(text).toContain("npx skills@latest add xxh171015/afk-platform");
    expect(text).toMatch(
      /Tracker doc\s+fail\s+.*docs\/agents\/issue-tracker.md/s,
    );
    expect(text).toContain("run the afk-setup skill");
    expect(text).toMatch(
      /AGENTS.md\s+fail\s+.*not on the default branch or origin\/afk\/setup/s,
    );
    expect(puts).toEqual([]);
  });

  it("stores the report on the project when asked, and still exits 0", async () => {
    const machine = io();
    const code = await run(
      ["--api-url", url, "--json", "doctor", "--project", "3"],
      machine,
    );
    expect(code).toBe(0);
    expect(puts).toHaveLength(1);
    const body = puts[0] as { machine: string; items: { id: string }[] };
    expect(body.machine.length).toBeGreaterThan(0);
    expect(body.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(["skills", "tracker-doc", "agents-md"]),
    );
    const printed = JSON.parse(machine.out.join("")) as { checkedAt: string };
    expect(printed.checkedAt).toBe("2026-11-11T05:00:00.000Z");
  });
});
