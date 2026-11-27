import { describe, expect, it } from "vitest";
import { run } from "./index.ts";

describe("plat spec recheck-baseline --help", () => {
  it("names the command that recuts from current main and runs the baseline gate again", async () => {
    let stdout = "";
    const code = await run(["spec", "recheck-baseline", "--help"], {
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
    expect(stdout).toContain("recheck-baseline");
    expect(stdout).toContain("重新检查");
  });
});
