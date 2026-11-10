import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../.sandcastle/Dockerfile", import.meta.url)),
  "utf8",
);

describe("the platform sandbox Dockerfile", () => {
  it("is the union of the pilot frontend image and this repo's extras, with Cursor CLI pinned", () => {
    expect(dockerfile).toMatch(/^FROM node:22-bookworm$/m);
    expect(dockerfile).toMatch(/^ARG PNPM_VERSION=/m);
    expect(dockerfile).toMatch(/postgresql/);
    // Must match afk-pilot-frontend's @playwright/test (checked on #233 against that package.json).
    expect(dockerfile).toMatch(/^ARG PLAYWRIGHT_VERSION=1\.64\.1$/m);
    expect(dockerfile).toMatch(
      /playwright@\$\{PLAYWRIGHT_VERSION\} install-deps chromium/,
    );
    expect(dockerfile).toMatch(
      /playwright@\$\{PLAYWRIGHT_VERSION\} install chromium/,
    );
    expect(dockerfile).toMatch(/^ARG CURSOR_CLI_VERSION=/m);
  });
});
