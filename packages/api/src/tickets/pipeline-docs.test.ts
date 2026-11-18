import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const design = readFileSync(
  fileURLToPath(new URL("../../../../docs/design.md", import.meta.url)),
  "utf8",
);
const glossary = readFileSync(
  fileURLToPath(new URL("../../../../GLOSSARY.md", import.meta.url)),
  "utf8",
);

describe("ticket pipeline docs", () => {
  it("the ticket pipeline is implement, then gate alongside review, then join, then merge", () => {
    const section = design.slice(
      design.indexOf("## 单票执行流水线"),
      design.indexOf("## blocked 处理"),
    );
    expect(section).toMatch(/implement → gate ∥ review → 汇合 → 合并/);
    expect(section).toMatch(/门禁不过时丢掉审查/);
    expect(section).toMatch(/丢掉的审查不算/);
    expect(section).toMatch(/审查结论只对它审的那个提交有效/);
    expect(design).toMatch(
      /执行（worker，每张票）[\s\S]*implement → gate ∥ review → 汇合 → 合并/,
    );
  });

  it("GLOSSARY Finding says a review dropped when the gate fails does not count as the one review", () => {
    const finding = glossary.slice(
      glossary.indexOf("**Finding（意见）**"),
      glossary.indexOf("**Tidy（整理）**"),
    );
    expect(finding).toMatch(/审查只跑一次/);
    expect(finding).toMatch(/门禁不过时被丢掉的那次不算/);
  });
});
