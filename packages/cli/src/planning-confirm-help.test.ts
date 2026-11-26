import { describe, expect, it } from "vitest";
import { run } from "./index.ts";

describe("plat spec confirm --help", () => {
  it("describes --send, --keep-local, --send-all and --keep-local-all instead of a fixed path list", async () => {
    let stdout = "";
    const code = await run(["spec", "confirm", "--help"], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      env: { HOME: "/nonexistent-home" },
      readFile: async () => {
        throw new Error("ENOENT");
      },
      readDirectory: async () => [],
    });
    expect(code).toBe(0);
    expect(stdout).toContain("--send");
    expect(stdout).toContain("--keep-local");
    expect(stdout).toContain("--send-all");
    expect(stdout).toContain("--keep-local-all");
    expect(stdout).not.toContain("GLOSSARY.md, docs/adr, AGENTS.md");
  });
});
