import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLATFORM_VERSION } from "./platform-version.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = (path: string) =>
  JSON.parse(readFileSync(`${root}${path}`, "utf8")) as { version?: string };

describe("the platform version", () => {
  it("is the version of the repo's root package.json, a semantic version", () => {
    expect(PLATFORM_VERSION).toBe(manifest("package.json").version);
    expect(PLATFORM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Guard: a second version in a package would be a second answer to "which platform is this".
  it("is written in no package of the workspace", () => {
    for (const name of readdirSync(`${root}packages`)) {
      expect(manifest(`packages/${name}/package.json`).version).toBeUndefined();
    }
  });
});
