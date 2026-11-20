import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("host-script documentation", () => {
  it("tells agents how host scripts must be written and classified", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/^## 宿主机脚本$/m);
    expect(agents).toContain("scripts/up.sh");
    expect(agents).toContain("scripts/restart.sh");
    expect(agents).toContain("scripts/canary.sh");
    expect(agents).toContain("scripts/drill.sh");
    expect(agents).toContain("scripts/check-sandbox-image.sh");
    expect(agents).toContain("scripts/verify-sandbox-image.sh");
    expect(agents).toContain("bash 3.2");
    expect(agents).toContain("BSD");
    expect(agents).toContain("scripts/check-portability.sh");
    expect(agents).toContain("# portable:");
  });

  it("says to rebuild the image then manually run check-portability.sh", () => {
    const manual = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    expect(manual).toContain("scripts/check-sandbox-image.sh");
    expect(manual).toContain("portability");
    expect(manual).toContain("scripts/check-portability.sh");
    expect(manual).toMatch(/兼容重跑/);
    expect(manual).toMatch(/小需求/);
  });

  it("explains the morning digest hints for stale and closed pull requests", () => {
    const manual = readFileSync(
      join(repoRoot, "docs/operations-manual.md"),
      "utf8",
    );
    expect(manual).toContain("已等 N 天，合并或取消");
    expect(manual).toContain("PR 已全部关闭，可以取消需求");
  });
});
