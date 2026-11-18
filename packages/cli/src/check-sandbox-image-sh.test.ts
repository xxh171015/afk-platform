import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repoRoot, "scripts/check-sandbox-image.sh");

let trash: string[] = [];
afterEach(() => {
  for (const path of trash) rmSync(path, { recursive: true, force: true });
  trash = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function stubDocker(awk: "bsd" | "missing" | "gnu"): string {
  const dir = tempDir("afk-sandbox-image-bin-");
  const awkBody = {
    bsd: 'echo "awk version 20200816"; exit 0',
    missing: 'echo "exec: /opt/macos-compat/bin/awk: not found" >&2; exit 127',
    gnu: 'echo "GNU Awk 5.1.0, API: 3.1"; exit 0',
  }[awk];
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then echo 104857600; exit 0; fi
if [ "$1" = run ]; then
  cmd="$*"
  case "$cmd" in
    *"--entrypoint agent"*) echo "2026.10.22-27dcf5f"; exit 0 ;;
    *"postgresql"*) echo "postgres (PostgreSQL) 16.1"; exit 0 ;;
    *"pnpm --version"*) echo "pnpm 12.15.0, node v22.0.0, go go1.24.4, playwright Version 1.64.1"; exit 0 ;;
    *"ms-playwright"*) echo "/home/agent/.cache/ms-playwright/chromium-1234"; exit 0 ;;
    *"macos-compat"*|*"original-awk"*)
      ${awkBody}
      ;;
  esac
fi
echo "unexpected docker $*" >&2
exit 1
`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

async function runCheck(awk: "bsd" | "missing" | "gnu") {
  const work = tempDir("afk-sandbox-image-");
  const envFile = join(work, "sandbox-image.env");
  try {
    const result = await execFileAsync("bash", [script], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env: {
        PATH: `${stubDocker(awk)}:${process.env.PATH}`,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SKIP_BUILD: "1",
        SKIP_PLATFORM_GATE: "1",
        ENV_FILE: envFile,
        AFK_PILOT_FRONTEND: join(work, "no-frontend"),
        AFK_PILOT_BACKEND: join(work, "no-backend"),
      },
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      envFile,
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      envFile,
    };
  }
}

describe("scripts/check-sandbox-image.sh", () => {
  it("records BSD awk from /opt/macos-compat/bin/awk in the sandbox-image report", async () => {
    const result = await runCheck("bsd");
    const output = `${result.stdout}${result.stderr}`;
    const report = readFileSync(result.envFile, "utf8");
    expect(report).toMatch(/^MACOS_AWK=awk version 20200816$/m);
    expect(output).toContain("awk version 20200816");
    expect(output).toContain("/opt/macos-compat/bin/awk");
  });

  it("fails when /opt/macos-compat/bin/awk is missing from the image", async () => {
    const result = await runCheck("missing");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("/opt/macos-compat/bin/awk");
    expect(readFileSync(result.envFile, "utf8")).not.toMatch(/^MACOS_AWK=/m);
  });

  it("fails when /opt/macos-compat/bin/awk is GNU awk", async () => {
    const result = await runCheck("gnu");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("expected BSD awk");
    expect(output).toContain("GNU Awk 5.1.0");
    expect(readFileSync(result.envFile, "utf8")).not.toMatch(/^MACOS_AWK=/m);
  });
});
