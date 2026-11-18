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

  it("does not put capability, memory or process limits in the image", () => {
    expect(dockerfile).not.toMatch(/cap-drop|no-new-privileges|pids-limit/);
  });

  it("installs original-awk and links it at /opt/macos-compat/bin/awk before USER", () => {
    expect(dockerfile).toMatch(
      /git \\\n\s+curl \\\n\s+jq \\\n\s+original-awk \\\n/,
    );
    const awkLink = dockerfile.search(
      /\/opt\/macos-compat\/bin\/awk.*\/usr\/bin\/original-awk|\/usr\/bin\/original-awk.*\/opt\/macos-compat\/bin\/awk/s,
    );
    expect(awkLink).toBeGreaterThan(-1);
    expect(dockerfile).toMatch(/# .*scripts\/check-portability\.sh.*macOS/);
    const user = dockerfile.search(/^USER /m);
    expect(user).toBeGreaterThan(awkLink);
  });
});
