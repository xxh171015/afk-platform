import { describe, expect, it } from "vitest";
import { run } from "./index.ts";

describe("plat spec continue-baseline --help", () => {
  it("names the command that continues after a failed baseline gate", async () => {
    let stdout = "";
    const code = await run(["spec", "continue-baseline", "--help"], {
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
    expect(stdout).toContain("continue-baseline");
    expect(stdout).toContain("不管它继续");
    expect(stdout).not.toContain("重新检查");
  });
});
