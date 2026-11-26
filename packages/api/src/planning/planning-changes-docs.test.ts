import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const adrDir = `${root}docs/adr`;

describe("planning docs chosen at confirm", () => {
  it("GLOSSARY Planning docs are picked by the person at confirm, not a fixed path list, and exclude machine-only planning files", () => {
    const glossary = read("GLOSSARY.md");
    const section = glossary.slice(
      glossary.indexOf("**Planning docs（规划文档）**"),
      glossary.indexOf("**Scratch files"),
    );
    expect(section).toContain("在 confirm 时由人选定交给平台");
    expect(section).toContain("不限路径和类型");
    expect(section).toContain("本机专用的规划文件");
    expect(section).toContain(
      "规划时的改动不由人提交，跟着这个 Spec 的代码一起进 PR",
    );
    expect(section).not.toMatch(/GLOSSARY\.md/);
    expect(section).not.toContain(
      "规划时写下的术语表、ADR 和写给 agent 的规范",
    );
  });

  it("ADR 0013 replaces which files count as planning docs; ADR 0005's header points to it", () => {
    const files = readdirSync(adrDir).filter((name) =>
      name.startsWith("0013-"),
    );
    expect(files).toHaveLength(1);
    const adr0013 = read(`docs/adr/${files[0]}`);
    expect(adr0013).toMatch(/规划文档由人在 confirm 时选定，不按路径挑/);
    expect(adr0013).toMatch(/取代[\s\S]*ADR 0005[\s\S]*路径/);
    expect(adr0013).toContain("有改动又没选时不放行");
    expect(adr0013).toMatch(/规划仓库认不出/);
    expect(adr0013).toMatch(/页面确认/);
    expect(adr0013).toMatch(/按路径或.*类型挑/);
    expect(adr0013).toMatch(/全部.*送/);
    expect(adr0013).toMatch(/拍快照/);
    expect(adr0013).toContain("/context/");
    expect(adr0013).toMatch(/工作区干净/);
    expect(adr0013).toMatch(/其他仓库的本地改动/);
    const adr0005 = read(
      "docs/adr/0005-planning-docs-go-with-the-spec-committed-by-the-platform.md",
    );
    const header = adr0005.slice(0, adr0005.indexOf("## "));
    expect(header).toMatch(/规划文档的范围被[\s\S]*ADR 0013[\s\S]*取代/);
  });

  it("the operations manual's step 1, step 4 and table 1.3 describe picking local changes at confirm, with --send / --keep-local examples", () => {
    const manual = read("docs/operations-manual.md");
    const table13 = manual.slice(
      manual.indexOf("### 1.3"),
      manual.indexOf("### 1.4"),
    );
    expect(table13).toMatch(/代码推到了远端/);
    expect(table13).toMatch(/plat spec confirm/);
    expect(table13).not.toMatch(/grill 产出的 `GLOSSARY\.md`、ADR 是例外/);

    const step1 = manual.slice(
      manual.indexOf("### 第 1 步 grill"),
      manual.indexOf("### 第 2 步"),
    );
    expect(step1).toMatch(/不用提交、也不用推送/);
    expect(step1).toMatch(/plat spec confirm/);
    expect(step1).toMatch(/由你选|人选|由人选/);

    const step4 = manual.slice(
      manual.indexOf("### 第 4 步"),
      manual.indexOf("### 第 5 步"),
    );
    expect(step4).toContain("--send");
    expect(step4).toContain("--keep-local");
    expect(step4).toContain("--send-all");
    expect(step4).toContain("--keep-local-all");
    expect(step4).toContain("--leave-planning-changes");
    expect(step4).toContain("不带这些改动，照样确认");
    expect(step4).toMatch(/\.env/);
    expect(step4).toMatch(/plat spec confirm S-n --send .+ --keep-local /);
  });

  it("CLAUDE.md planning rules tell the agent to show confirm's local-change list to the person", () => {
    const claude = read("CLAUDE.md");
    const section = claude.slice(
      claude.indexOf("## 在这个仓库里规划"),
      claude.indexOf("## Agent skills"),
    );
    expect(section).toContain("把清单给人看，问哪些是这次规划改的");
    expect(section).toContain("--send");
    expect(section).toContain("--keep-local");
  });
});
