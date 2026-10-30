import { describe, expect, it } from "vitest";
import { exec } from "./exec.ts";

describe("exec", () => {
  it("kills a program that runs longer than timeoutMs, and says so", () => {
    const result = exec(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        timeoutMs: 500,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("leaves timedOut out for a program that finishes in time", () => {
    const result = exec(process.execPath, ["-e", "console.log('hi')"], {
      timeoutMs: 5000,
    });
    expect(result).toEqual({ code: 0, out: "hi\n", stdout: "hi\n" });
  });
});
