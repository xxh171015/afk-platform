import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StructuredOutputError } from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import { agentEnv, classifyAgentError, sandboxMounts } from "./sandcastle.ts";

// What can be checked without Docker: the configuration handed to Sandcastle, how its errors are read, and
// that Sandcastle stays behind this one module. The real thing is exercised by the interruption drill (#42).

describe("the mounts", () => {
  it("gives the agent /context and the skills, both read-only", () => {
    expect(
      sandboxMounts({ ctxDir: "/host/ctx", skillsMount: "/host/skills" }),
    ).toEqual([
      { hostPath: "/host/ctx", sandboxPath: "/context", readonly: true },
      {
        hostPath: "/host/skills",
        sandboxPath: "/home/agent/.cursor/skills",
        readonly: true,
      },
    ]);
  });

  it("gives the gate sandbox no /context", () => {
    expect(sandboxMounts({ skillsMount: "/host/skills" })).toEqual([
      {
        hostPath: "/host/skills",
        sandboxPath: "/home/agent/.cursor/skills",
        readonly: true,
      },
    ]);
  });

  it("never mounts anything writable", () => {
    for (const mount of sandboxMounts({ ctxDir: "/c", skillsMount: "/s" })) {
      expect(mount.readonly).toBe(true);
    }
  });
});

describe("the environment", () => {
  it("is the Cursor API key and nothing else", () => {
    expect(agentEnv("key-123")).toEqual({ CURSOR_API_KEY: "key-123" });
  });
});

describe("reading Sandcastle's errors", () => {
  it("unusable structured output is invalid-output, and keeps the commits the run made", () => {
    const error = new StructuredOutputError("bad result", {
      tag: "result",
      rawMatched: "{",
      cause: new Error("json"),
      commits: [{ sha: "abc" }, { sha: "def" }],
      branch: "agent/T-1",
    });
    expect(classifyAgentError(error)).toMatchObject({
      errorKind: "invalid-output",
      commits: ["abc", "def"],
    });
  });

  it("the wall-clock abort and an idle timeout are timeouts", () => {
    expect(classifyAgentError(new Error("wall-clock")).errorKind).toBe(
      "timeout",
    );
    const idle = new Error("agent produced no output");
    idle.name = "IdleTimeoutError";
    expect(classifyAgentError(idle).errorKind).toBe("timeout");
  });

  it("anything else is an infrastructure problem, not the ticket's fault", () => {
    expect(
      classifyAgentError(new Error("docker daemon not running")),
    ).toMatchObject({
      errorKind: "other",
      commits: [],
    });
    expect(classifyAgentError("a string").errorKind).toBe("other");
  });
});

describe("Sandcastle stays behind one module, at one version", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules") return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("is imported by sandcastle.ts and nowhere else", () => {
    const importers = sources(packages).filter((file) =>
      /from\s+["']@ai-hero\/sandcastle/.test(readFileSync(file, "utf8")),
    );
    expect(importers.map((file) => file.slice(packages.length)).sort()).toEqual(
      ["pipeline/src/sandcastle.test.ts", "pipeline/src/sandcastle.ts"],
    );
  });

  it("is pinned to exactly 0.12.0", () => {
    const manifest = JSON.parse(
      readFileSync(join(packages, "pipeline", "package.json"), "utf8"),
    );
    expect(manifest.dependencies["@ai-hero/sandcastle"]).toBe("0.12.0");
  });
});
