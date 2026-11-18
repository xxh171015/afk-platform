import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
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
const checkerSrc = join(repoRoot, "scripts/check-portability.sh");

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

function fakeScripts(files: Record<string, string>): string {
  const root = tempDir("afk-portability-");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(checkerSrc, join(scripts, "check-portability.sh"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(scripts, name), body);
  }
  return join(scripts, "check-portability.sh");
}

async function runChecker(
  scriptPath: string,
  env: Record<string, string | undefined> = {},
  cwd?: string,
) {
  const missingCompat = join(tempDir("afk-no-compat-"), "bin");
  try {
    const result = await execFileAsync("bash", [scriptPath], {
      encoding: "utf8",
      timeout: 20_000,
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        AFK_MACOS_COMPAT_DIR: missingCompat,
        ...env,
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
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
    };
  }
}

describe("scripts/check-portability.sh", () => {
  it("fails when scripts/ has a .sh that is not on the host or sandbox list", async () => {
    const checker = fakeScripts({
      "orphan.sh": "#!/bin/sh\n",
    });
    const result = await runChecker(checker);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("orphan.sh");
  });

  it("reports each non-portable construct with file and line and skips # portable: lines", async () => {
    const body = [
      "#!/usr/bin/env bash",
      "cat /proc/cpuinfo",
      "wait -n",
      "declare -A foo",
      "local -A bar",
      "mapfile xs",
      "readarray ys",
      `echo "\${name,,}"`,
      `echo "\${name^^}"`,
      "foo |& bar",
      "foo &>> /tmp/x",
      "readlink -f /tmp",
      "realpath /tmp",
      "sed -i 's/a/b/' file",
      "date -d yesterday",
      "stat -c %s file",
      "grep -P foo",
      "xargs -r echo",
      "find . -printf '%p\\n'",
      "echo x | base64 -w 0",
      "timeout 1 true",
      "setsid true",
      "cat /proc/cpuinfo  # portable: allowed in this sample",
    ].join("\n");
    const checker = fakeScripts({ "up.sh": `${body}\n` });
    const result = await runChecker(checker);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    const expected: Array<[number, string]> = [
      [2, "/proc/"],
      [3, "wait -n"],
      [4, "declare -A"],
      [5, "local -A"],
      [6, "mapfile"],
      [7, "readarray"],
      [8, `\${var,,}`],
      [9, `\${var^^}`],
      [10, "|&"],
      [11, "&>>"],
      [12, "readlink -f"],
      [13, "realpath"],
      [14, "sed -i"],
      [15, "date -d"],
      [16, "stat -c"],
      [17, "grep -P"],
      [18, "xargs -r"],
      [19, "find -printf"],
      [20, "base64 -w"],
      [21, "timeout"],
      [22, "setsid"],
    ];
    for (const [line, token] of expected) {
      expect(output).toMatch(
        new RegExp(
          `scripts/up\\.sh:${line}: ${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — .+`,
        ),
      );
    }
    expect(output).not.toContain("scripts/up.sh:23:");
  });

  it("skips macos-compat when the directory is missing and lets static checks decide the exit", async () => {
    const missing = join(tempDir("afk-missing-compat-"), "bin");
    const clean = fakeScripts({});
    const cleanResult = await runChecker(clean, {
      AFK_MACOS_COMPAT_DIR: missing,
    });
    const cleanOutput = `${cleanResult.stdout}${cleanResult.stderr}`;
    expect(cleanResult.status).toBe(0);
    expect(cleanOutput).toContain(
      `macos-compat: skipped (no ${missing} in this image)`,
    );

    const dirty = fakeScripts({ "orphan.sh": "#!/bin/sh\n" });
    const dirtyResult = await runChecker(dirty, {
      AFK_MACOS_COMPAT_DIR: missing,
    });
    const dirtyOutput = `${dirtyResult.stdout}${dirtyResult.stderr}`;
    expect(dirtyResult.status).not.toBe(0);
    expect(dirtyOutput).toContain(
      `macos-compat: skipped (no ${missing} in this image)`,
    );
    expect(dirtyOutput).toContain("orphan.sh");
  });

  it("reruns the listed tests with macos-compat first on PATH and TMPDIR a symlink", async () => {
    const work = tempDir("afk-compat-");
    const compat = join(work, "macos-compat", "bin");
    mkdirSync(compat, { recursive: true });
    const awkLog = join(work, "awk.log");
    writeFileSync(
      join(compat, "awk"),
      `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(awkLog)}\n`,
    );
    chmodSync(join(compat, "awk"), 0o755);

    const pnpmDir = join(work, "pnpm-bin");
    mkdirSync(pnpmDir);
    const pnpmLog = join(work, "pnpm.log");
    writeFileSync(
      join(pnpmDir, "pnpm"),
      `#!/bin/sh
printf 'args=%s\\n' "$*" >> ${JSON.stringify(pnpmLog)}
printf 'PATH=%s\\n' "$PATH" >> ${JSON.stringify(pnpmLog)}
printf 'TMPDIR=%s\\n' "$TMPDIR" >> ${JSON.stringify(pnpmLog)}
if [ -L "\${TMPDIR%/}" ]; then
  printf 'TMPDIR_IS_SYMLINK=1\\n' >> ${JSON.stringify(pnpmLog)}
fi
awk 'BEGIN { }'
`,
    );
    chmodSync(join(pnpmDir, "pnpm"), 0o755);

    const checker = fakeScripts({});
    const result = await runChecker(
      checker,
      {
        AFK_MACOS_COMPAT_DIR: compat,
        PATH: `${pnpmDir}:${process.env.PATH}`,
      },
      work,
    );
    expect(result.status).toBe(0);
    const pnpmText = readFileSync(pnpmLog, "utf8");
    expect(pnpmText).toContain("packages/cli/src/up-sh.test.ts");
    expect(pnpmText).toContain("packages/cli/src/canary-sh.test.ts");
    expect(pnpmText).toMatch(
      new RegExp(
        `^PATH=${compat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
        "m",
      ),
    );
    expect(pnpmText).toContain("TMPDIR_IS_SYMLINK=1");
    expect(readFileSync(awkLog, "utf8")).toContain("called");
  });

  it("static-checks the repo scripts/ without findings", async () => {
    const result = await runChecker(checkerSrc, {}, repoRoot);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("macos-compat: skipped");
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/scripts\/[^:\n]+:[0-9]+: /);
  });
});
