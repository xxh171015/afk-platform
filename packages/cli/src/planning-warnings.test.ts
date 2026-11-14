import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "./index.ts";

let server: Server;
let url: string;

beforeEach(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/specs") {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: 7, displayId: "S-7", warnings: [] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no such project" }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise((done) => server.close(done)));

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { HOME: "/nonexistent-home" },
    readFile: async () => {
      throw new Error("ENOENT");
    },
    readDirectory: async () => [],
  };
}

describe("plat spec create on a machine that is not set up for planning", () => {
  it("still creates the spec and exits 0, and warns about the tracker doc and both skills", async () => {
    const machine = io();
    const code = await run(
      [
        "--api-url",
        url,
        "spec",
        "create",
        "--project",
        "3",
        "--type",
        "feature",
        "--title",
        "Export",
        "--slug",
        "export",
      ],
      machine,
    );
    expect(code).toBe(0);
    expect(machine.out.join("")).toBe("S-7\n");
    const warnings = machine.err.join("");
    expect(warnings).toContain(
      "this repo is not set up for the platform (no docs/agents/issue-tracker.md): run the afk-setup skill",
    );
    expect(warnings).toMatch(/to-spec, to-tickets not found in this repo/);
    expect(warnings).toContain("plat sync");
  });
});
